// Packaged desktop, on camera: the REAL electron-builder bundle (app.isPackaged
// === true) attaches to an already-running OS-supervised daemon instead of
// spawning its own sidecar. This is the production-only path — dev electron skips
// ensureSupervisedConnection entirely and always spawns a desktop-sidecar, so the
// attach behavior can ONLY be proven against the packaged artifact.
//
// We start the daemon as the bundle's OWN compiled `executor-sidecar` (the exact
// binary a supervised install runs) in EXECUTOR_SUPERVISED mode → it self-
// publishes a manifest of kind "cli-daemon". Then we launch the packaged app
// pointed at the same HOME and prove it attached: the manifest still names the
// daemon's pid (a spawned sidecar would rewrite it to "desktop-sidecar" with a
// fresh pid), and the console — served by the bearer-gated daemon — renders,
// which only happens if the app injected the bearer it read from the manifest.
// The recording (session.mp4 + screenshots) is the artifact; the waits assert.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { _electron } from "playwright";

import { scenario } from "../src/scenario";
import { RunDir } from "../src/services";
import { waitForHttp } from "../setup/boot";

// Driving the packaged Electron app needs a real window-server session: Aqua on
// macOS, an X/Wayland display on Linux. An SSH/CI shell runs in the background
// (non-GUI) session where Electron can't open a window — so this scenario runs
// only where a display is reachable (a logged-in console, or a guest under
// autologin/Xvfb) and skips honestly elsewhere rather than hanging on launch.
const guiAvailable = (): boolean => {
  if (process.platform === "darwin") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing the session manager; absence = no GUI
    try {
      return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return true; // windows: the runner places this in an interactive session
};

const SCENARIO_NAME = "Desktop (packaged) · the real bundle attaches to the OS-supervised daemon";

const appExe = process.env.E2E_DESKTOP_APP_EXE;
const sidecarBin = process.env.E2E_DESKTOP_SIDECAR_BIN;
// The bundled web UI sits beside the sidecar in Resources/ (…/sidecar/<bin> →
// …/web-ui). The compiled sidecar serves it via EXECUTOR_CLIENT_DIR.
const clientDir = sidecarBin ? join(dirname(dirname(sidecarBin)), "web-ui") : "";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

interface Manifest {
  readonly kind: string;
  readonly pid: number;
}

interface DaemonStart {
  readonly child: ChildProcess;
  readonly ready: boolean;
  readonly stderr: string;
}

/** Spawn the bundle's compiled sidecar as a supervised daemon; resolves once it
 *  announces EXECUTOR_READY (or times out / exits early, ready:false). */
const startSupervisedDaemon = (env: NodeJS.ProcessEnv): Promise<DaemonStart> =>
  new Promise((resolve) => {
    const child = spawn(sidecarBin as string, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const settle = (ready: boolean) => resolve({ child, ready, stderr });
    const timer = setTimeout(() => settle(false), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("EXECUTOR_READY:")) {
        clearTimeout(timer);
        settle(true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

if (!guiAvailable()) {
  it.skip(`${SCENARIO_NAME} (needs a GUI display — Aqua / X / Wayland)`, () => {});
} else {
  scenario(
    SCENARIO_NAME,
    { timeout: 240_000 },
    Effect.gen(function* () {
      if (!appExe || !sidecarBin) {
        return yield* Effect.die(
          "E2E_DESKTOP_APP_EXE / E2E_DESKTOP_SIDECAR_BIN not set — did desktop-packaged.globalsetup run?",
        );
      }
      const runDir = yield* RunDir;
      yield* Effect.promise(() => run(runDir));
    }),
  );
}

const run = async (runDir: string) => {
  const home = mkdtempSync(join(tmpdir(), "executor-pkg-attach-"));
  const dataDir = join(home, ".executor");
  const manifestPath = join(dataDir, "server-control", "server.json");
  const videoTmp = join(runDir, ".video-tmp");
  const port = await freePort();

  let daemon: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let stepIndex = 0;

  try {
    const started = await startSupervisedDaemon({
      ...process.env,
      HOME: home,
      EXECUTOR_SUPERVISED: "1",
      EXECUTOR_DATA_DIR: dataDir,
      EXECUTOR_PORT: String(port),
      EXECUTOR_HOST: "127.0.0.1",
      EXECUTOR_AUTH_TOKEN: "packaged-attach-film",
      EXECUTOR_CLIENT_DIR: clientDir,
    });
    daemon = started.child;
    expect(started.ready, `supervised daemon became ready; stderr:\n${started.stderr}`).toBe(true);
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 30_000 });

    const daemonManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(daemonManifest.kind, "the compiled sidecar advertises itself as cli-daemon").toBe(
      "cli-daemon",
    );
    const daemonPid = daemonManifest.pid;

    // Launch the PACKAGED bundle (executablePath = the installed app binary, no
    // app-dir arg) → app.isPackaged is true → boot() runs the supervised attach.
    app = await _electron.launch({
      executablePath: appExe as string,
      env: { ...process.env, HOME: home },
      recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
      timeout: 120_000,
    });

    const page = await app.firstWindow({ timeout: 120_000 });
    const step = async (label: string, body: () => Promise<void>) => {
      await body();
      stepIndex += 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await page.screenshot({
        path: join(runDir, `${String(stepIndex).padStart(2, "0")}-${slug}.png`),
      });
    };

    // The console only renders once the app has a live connection AND the bearer
    // it injects is accepted by the gated daemon — so reaching it proves both the
    // attach and the bearer wiring through the packaged session layer.
    await step("packaged app boots into the bearer-gated console", async () => {
      await page.getByText("Settings").first().waitFor({ timeout: 120_000 });
    });

    // Proof it ATTACHED, not spawned: the manifest is untouched — same pid, still
    // cli-daemon. A managed sidecar would have rewritten it to "desktop-sidecar".
    await step("server manifest still names the supervised daemon", async () => {
      const after = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      expect(after.kind, "still the supervised daemon (not a desktop sidecar)").toBe("cli-daemon");
      expect(after.pid, "the packaged app attached to our daemon, not a new sidecar").toBe(
        daemonPid,
      );
    });
  } finally {
    const page = app?.windows()[0];
    const video = page?.video();
    await app?.close().catch(() => {});
    const recordedPath = await video?.path().catch(() => undefined);
    if (recordedPath && existsSync(recordedPath)) {
      await promisify(execFile)("ffmpeg", [
        "-y",
        "-i",
        recordedPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(runDir, "session.mp4"),
      ]).catch(() => {});
    }
    daemon?.kill("SIGTERM");
    rmSync(videoTmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};
