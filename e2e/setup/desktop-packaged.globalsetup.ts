// Packaged-desktop project setup: produce the REAL electron-builder bundle (not
// dev electron) so the scenarios drive the production artifact — the only place
// app.isPackaged is true, which is what gates the supervised-daemon attach path
// (ensureSupervisedConnection → attachToSupervisedDaemon) and the bundled
// compiled sidecar (executor-sidecar + extraResources). The dev-electron desktop
// project can't reach any of that.
//
// Builds web UI → compiled sidecar → electron-vite main/preload → electron-builder
// (unsigned e2e config, `dir` target = the unpacked .app/.exe, no DMG/notarize).
// Publishes the launch exe + the bundled sidecar path via env for the workers.
//
// Slow (~3-5min: a full compile + package). Set E2E_DESKTOP_SKIP_BUILD=1 to
// reuse an existing dist/ bundle while iterating.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));

// (launch exe, bundled sidecar binary) inside the packaged bundle, per platform.
const bundlePaths = (): { exe: string; sidecar: string } => {
  const arch = process.arch; // arm64 | x64
  if (process.platform === "darwin") {
    const app = join(appDir, "dist", `mac${arch === "arm64" ? "-arm64" : ""}`, "Executor.app");
    return {
      exe: join(app, "Contents/MacOS/Executor"),
      sidecar: join(app, "Contents/Resources/sidecar/executor-sidecar"),
    };
  }
  if (process.platform === "win32") {
    const dir = join(appDir, "dist", "win-unpacked");
    return {
      exe: join(dir, "Executor.exe"),
      sidecar: join(dir, "resources/sidecar/executor-sidecar.exe"),
    };
  }
  // electron-builder names the dir `linux-unpacked` for x64 and
  // `linux-<arch>-unpacked` otherwise; executableName is pinned in the e2e config.
  const dir = join(appDir, "dist", arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`);
  return {
    exe: join(dir, "executor-desktop"),
    sidecar: join(dir, "resources/sidecar/executor-sidecar"),
  };
};

const builderFlag =
  process.platform === "darwin" ? "--mac" : process.platform === "win32" ? "--win" : "--linux";

export default function setup() {
  const { exe, sidecar } = bundlePaths();

  if (process.env.E2E_DESKTOP_SKIP_BUILD !== "1" || !existsSync(exe)) {
    const run = (cmd: string, args: string[], cwd: string) =>
      execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env } });
    // 1. web UI bundle (served by the sidecar; staged into the package).
    run("bun", ["run", "--filter", "@executor-js/local", "build"], repoRoot);
    // 2. compiled sidecar + native bindings → resources/sidecar.
    run("bun", ["./scripts/build-sidecar.ts"], appDir);
    // 3. electron-vite main/preload → out/.
    run("bunx", ["--bun", "electron-vite", "build"], appDir);
    // 4. electron-builder unsigned bundle (dir target). CSC_IDENTITY_AUTO_DISCOVERY
    //    off so it never reaches for a signing identity.
    execFileSync(
      "bunx",
      ["--bun", "electron-builder", "--config", "electron-builder.e2e.config.ts", builderFlag],
      {
        cwd: appDir,
        stdio: "inherit",
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      },
    );
  }

  if (!existsSync(exe)) {
    throw new Error(`packaged desktop exe not found at ${exe} after build`);
  }
  if (!existsSync(sidecar)) {
    throw new Error(`bundled sidecar not found at ${sidecar} after build`);
  }
  process.env.E2E_DESKTOP_APP_EXE = exe;
  process.env.E2E_DESKTOP_SIDECAR_BIN = sidecar;
}
