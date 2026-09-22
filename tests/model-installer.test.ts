import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL_NAME,
  WHISPER_MODELS,
  downloadModel,
  findInstalledModel,
  findModelSpec,
  formatBytes,
  modelPath,
  modelUrl,
  modelsDir,
  resumeOffset,
  sizeMismatchMessage
} from "../desktop/dictation/model-installer.ts";

let tempModels = "";
const originalOverride = process.env.MARSHAL_MODELS_DIR;

beforeEach(() => {
  tempModels = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-models-"));
  process.env.MARSHAL_MODELS_DIR = tempModels;
});

afterEach(() => {
  fs.rmSync(tempModels, { recursive: true, force: true });
  if (originalOverride === undefined) delete process.env.MARSHAL_MODELS_DIR;
  else process.env.MARSHAL_MODELS_DIR = originalOverride;
});

describe("model catalogue", () => {
  it("lists turbo first — that is the default the resolver relies on", () => {
    expect(WHISPER_MODELS[0].name).toBe(DEFAULT_MODEL_NAME);
  });

  it("gives every model a name, a label and a positive size", () => {
    for (const model of WHISPER_MODELS) {
      expect(model.name).toMatch(/^ggml-.+\.bin$/u);
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.bytes).toBeGreaterThan(0);
    }
  });

  it("findModelSpec rejects anything not in the catalogue", () => {
    expect(findModelSpec(DEFAULT_MODEL_NAME)?.label).toBe("large-v3-turbo");
    expect(findModelSpec("ggml-made-up.bin")).toBeUndefined();
  });
});

describe("modelsDir", () => {
  it("honours MARSHAL_MODELS_DIR", () => {
    expect(modelsDir()).toBe(tempModels);
    expect(modelPath("ggml-small.bin")).toBe(path.join(tempModels, "ggml-small.bin"));
  });

  it("ignores a blank override so a stray empty env var cannot point at /", () => {
    process.env.MARSHAL_MODELS_DIR = "   ";
    expect(modelsDir()).not.toBe("   ");
    expect(path.isAbsolute(modelsDir())).toBe(true);
  });

  describe("stays outside the app bundle and outside the repo", () => {
    // The directory is per platform, so pin each one instead of asserting
    // whatever the CI runner happens to be (#183).
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;
    const pin = (platform: NodeJS.Platform): void => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true, writable: true });
    };
    afterEach(() => {
      pin(originalPlatform);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    });

    it("macOS: Application Support, not inside Marshal.app", () => {
      delete process.env.MARSHAL_MODELS_DIR;
      pin("darwin");
      const dir = modelsDir();
      expect(dir).toBe(path.join(os.homedir(), "Library", "Application Support", "Marshal", "models"));
      expect(dir).not.toContain(".app");
      expect(dir).not.toContain("/htdocs/marshal/");
    });

    it("Windows: %APPDATA%\\Marshal", () => {
      delete process.env.MARSHAL_MODELS_DIR;
      process.env.APPDATA = path.join("C:", "Users", "me", "AppData", "Roaming");
      pin("win32");
      expect(modelsDir()).toBe(path.join(process.env.APPDATA, "Marshal", "models"));
    });

    it("Linux: XDG data home", () => {
      delete process.env.MARSHAL_MODELS_DIR;
      pin("linux");
      expect(modelsDir()).toBe(path.join(os.homedir(), ".local", "share", "marshal", "models"));
    });
  });
});

describe("modelUrl", () => {
  // The ggml-org mirror answers 401; ggerganov is what upstream's own
  // download-ggml-model.sh uses. Verified 2026-09-16.
  it("points at the upstream repository", () => {
    expect(modelUrl("ggml-small.bin")).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
    );
  });
});

describe("findInstalledModel", () => {
  it("returns null on an empty models directory", () => {
    expect(findInstalledModel()).toBeNull();
  });

  it("ignores a leftover .part file", () => {
    fs.writeFileSync(path.join(tempModels, "ggml-small.bin.part"), "x");
    expect(findInstalledModel()).toBeNull();
  });

  it("ignores a zero-byte file", () => {
    fs.writeFileSync(path.join(tempModels, "ggml-small.bin"), "");
    expect(findInstalledModel()).toBeNull();
  });

  it("prefers the higher-priority model when several are present", () => {
    fs.writeFileSync(path.join(tempModels, "ggml-small.bin"), "s");
    fs.writeFileSync(path.join(tempModels, "ggml-large-v3-turbo.bin"), "t");
    expect(findInstalledModel()?.name).toBe("ggml-large-v3-turbo.bin");
  });
});

describe("resumeOffset", () => {
  it("resumes from a short partial file", () => {
    expect(resumeOffset(100, 500)).toBe(100);
  });

  it("treats a partial at or beyond the expected size as junk", () => {
    expect(resumeOffset(500, 500)).toBe(0);
    expect(resumeOffset(900, 500)).toBe(0);
  });

  it("returns 0 for empty and nonsense sizes", () => {
    expect(resumeOffset(0, 500)).toBe(0);
    expect(resumeOffset(-1, 500)).toBe(0);
    expect(resumeOffset(Number.NaN, 500)).toBe(0);
  });
});

describe("sizeMismatchMessage", () => {
  it("names both sizes so the failure is diagnosable", () => {
    const message = sizeMismatchMessage(42, WHISPER_MODELS[2]);
    expect(message).toContain("42");
    expect(message).toContain(String(WHISPER_MODELS[2].bytes));
    expect(message).toContain(WHISPER_MODELS[2].name);
  });
});

describe("downloadModel", () => {
  it("refuses a model that is not in the catalogue", async () => {
    await expect(downloadModel("ggml-made-up.bin")).rejects.toThrow(/Unknown whisper model/u);
  });

  it("surfaces an HTTP failure with the URL", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(
      downloadModel("ggml-small.bin", { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/HTTP 404.*ggml-small\.bin/u);
  });

  it("discards a truncated download instead of leaving a half model behind", async () => {
    const fetchImpl = async () => new Response("too short", { status: 200 });
    await expect(
      downloadModel("ggml-small.bin", { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/should be/u);

    expect(fs.existsSync(path.join(tempModels, "ggml-small.bin"))).toBe(false);
    expect(fs.existsSync(path.join(tempModels, "ggml-small.bin.part"))).toBe(false);
  });

  it("asks the server to resume from what the .part file already holds", async () => {
    fs.writeFileSync(path.join(tempModels, "ggml-small.bin.part"), "0123456789");
    let seenRange: string | undefined;

    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seenRange = (init?.headers as Record<string, string> | undefined)?.Range;
      return new Response("rest", { status: 206 });
    };

    await expect(
      downloadModel("ggml-small.bin", { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/should be/u);

    expect(seenRange).toBe("bytes=10-");
  });

  it("reports progress against the expected size", async () => {
    const seen: number[] = [];
    const fetchImpl = async () => new Response("abc", { status: 200 });

    await downloadModel("ggml-small.bin", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress: ({ received }) => seen.push(received)
    }).catch(() => {});

    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(3);
  });
});

describe("formatBytes", () => {
  it("scales into human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_624_555_275)).toBe("1.5 GB");
  });

  it("does not print nonsense for bad input", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
