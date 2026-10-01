import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareDriveFileWithUsers, uploadSongToDrive } from "../services/drive.js";
import { actor, overHttp, request, type Actor } from "../test/integration/harness.js";

/**
 * The chunked song upload, end to end through the API: multipart parsing,
 * chunks written to disk and reassembled, format checks, the song row, the
 * background tagging-and-upload, and cleanup when that fails. Everything is
 * real except Google Drive itself: CI has no Drive, so the two Drive calls
 * are stand-ins (set up in test/integration/setup.ts) that record what
 * they were handed. The live contract suite
 * (deejaytools-com) uploads to the real Drive on dev.
 *
 * Over HTTP (INTEGRATION_BASE_URL) the stand-ins cannot reach the target, so
 * the success-path test is skipped; the others hold because a target run
 * without Drive credentials fails every Drive call for real.
 */
// The Drive calls are vi.fn wrappers set up in test/integration/setup.ts.
const upload = vi.mocked(uploadSongToDrive);
const share = vi.mocked(shareDriveFileWithUsers);

afterEach(() => {
  // Back to the real implementations for every other test.
  upload.mockRestore();
  share.mockRestore();
  upload.mockClear();
  share.mockClear();
});

/** A small file that passes the MP3 check: an empty ID3v2.4 header, then a
 * recognisable payload standing in for the audio frames. */
const AUDIO_PAYLOAD = Buffer.from(`audio-frames-${"x".repeat(3000)}-end`);
const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), AUDIO_PAYLOAD]);

function split(bytes: Buffer, parts: number): Buffer[] {
  const size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
}

function sendChunk(
  user: Actor,
  opts: { uploadId: string; index: number; total: number; bytes: Buffer; extra?: Record<string, string> }
) {
  const form = new FormData();
  form.set("upload_id", opts.uploadId);
  form.set("chunk_index", String(opts.index));
  form.set("total_chunks", String(opts.total));
  form.set("original_filename", "my routine.mp3");
  form.set("mime_type", "audio/mpeg");
  form.set("division", "Classic");
  for (const [k, v] of Object.entries(opts.extra ?? {})) form.set(k, v);
  form.set("chunk", new File([new Uint8Array(opts.bytes)], "chunk"));
  return request("POST", "/v1/songs/upload/chunk", { token: user.token, form });
}

/** The background upload runs after the response; wait for its outcome. */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("song upload (integration)", () => {
  it.skipIf(overHttp)("reassembles chunks sent out of order, uploads the tagged file, and records where it went", async () => {
    upload.mockResolvedValue({ fileId: "drive-file-1", folderId: "drive-folder-1" });
    share.mockResolvedValue({ shared: [], failed: [] } as never);
    const alice = await actor("alice");
    const partner = await alice.post("/v1/partners", { first_name: "Pat", last_name: "Partner", partner_role: "follower" });
    const uploadId = randomUUID();
    const [c0, c1, c2] = split(MP3, 3);

    // Middle chunks may arrive in any order; the last one triggers assembly.
    expect((await sendChunk(alice, { uploadId, index: 1, total: 3, bytes: c1 })).body.data).toEqual({
      received: true,
      complete: false,
    });
    await sendChunk(alice, { uploadId, index: 0, total: 3, bytes: c0 });
    const last = await sendChunk(alice, {
      uploadId,
      index: 2,
      total: 3,
      bytes: c2,
      extra: { partner_id: partner.body.data.id, routine_name: "Blue Monday" },
    });
    expect(last.status).toBe(200);
    expect(last.body.data.complete).toBe(true);
    const songId = last.body.data.song.id as string;

    const song = await eventually(
      () => alice.get(`/v1/songs/${songId}`),
      (r) => r.body?.data?.drive_file_id === "drive-file-1"
    );
    expect(song.body.data).toMatchObject({ drive_file_id: "drive-file-1", division: "Classic" });

    expect(upload).toHaveBeenCalledTimes(1);
    const [bytes, opts] = upload.mock.calls[0];
    // Tagging adds metadata, so the file handed to Drive is the original
    // audio with tags — never a truncated or reordered reassembly.
    expect(bytes.includes(AUDIO_PAYLOAD)).toBe(true);
    expect(opts).toMatchObject({ division: "Classic", mimeType: "audio/mpeg" });
    // Named from the uploader, partner, division, season and routine; the
    // song row records the same name.
    expect(opts.filename).toMatch(/^AliceTester_PatPartner_Classic_\d{4}_BlueMonday_v01\.mp3$/);
    expect(song.body.data.processed_filename).toBe(opts.filename);
  });

  it("removes the song again when the Drive upload fails, so no broken entry is left behind", async () => {
    upload.mockRejectedValue(new Error("Drive is down"));
    const alice = await actor("alice");
    const uploadId = randomUUID();
    const last = await sendChunk(alice, { uploadId, index: 0, total: 1, bytes: MP3 });
    expect(last.status).toBe(200);
    const songId = last.body.data.song.id as string;

    const gone = await eventually(
      () => alice.get(`/v1/songs/${songId}`),
      (r) => r.status === 404
    );
    expect(gone.status).toBe(404);
  });

  it("refuses an upload with a missing chunk, a non-audio file, or a malformed upload id", async () => {
    const alice = await actor("alice");

    const gappy = randomUUID();
    await sendChunk(alice, { uploadId: gappy, index: 0, total: 3, bytes: MP3.subarray(0, 100) });
    const missing = await sendChunk(alice, { uploadId: gappy, index: 2, total: 3, bytes: MP3.subarray(200) });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe("CHUNK_MISSING");

    const notAudio = await sendChunk(alice, {
      uploadId: randomUUID(),
      index: 0,
      total: 1,
      bytes: Buffer.from("this is a text file, not a song"),
    });
    expect(notAudio.status).toBe(400);
    expect(notAudio.body.error.code).toBe("UNSUPPORTED_FORMAT");

    const bad = await sendChunk(alice, { uploadId: "not-a-uuid", index: 0, total: 1, bytes: MP3 });
    expect(bad.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it("a partner that isn't yours is refused", async () => {
    const alice = await actor("alice");
    const bob = await actor("bob");
    const bobsPartner = await bob.post("/v1/partners", { first_name: "B", last_name: "P", partner_role: "follower" });
    const res = await sendChunk(alice, {
      uploadId: randomUUID(),
      index: 0,
      total: 1,
      bytes: MP3,
      extra: { partner_id: bobsPartner.body.data.id },
    });
    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});
