const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCommitDiff, createS3ObjectReader } = require("../services/diffService");
const {
  findCommitDescriptor,
  getParentCommitDescriptor,
  reconstructSnapshot,
} = require("../services/snapshotService");

const snapshot = (files) => new Map(files.map((file) => [file.path, file]));
const storedFile = (filePath, key, hash) => ({
  filename: filePath.split("/").at(-1),
  path: filePath,
  s3Key: key,
  hash,
});

function memoryReader(objects, calls = []) {
  return async (file) => {
    calls.push(file.s3Key);
    const value = objects[file.s3Key];
    if (value instanceof Error || value === undefined) {
      return { available: false, error: "Historical file content is unavailable" };
    }
    return {
      available: true,
      body: Buffer.isBuffer(value) ? value : Buffer.from(value),
      contentType: "text/plain",
    };
  };
}

test("added text files produce added lines and nested paths", async () => {
  const result = await buildCommitDiff(new Map(), snapshot([
    storedFile("frontend/src/NewPage.jsx", "new", "new-hash"),
  ]), { readObject: memoryReader({ new: "first\nsecond\n" }) });
  assert.deepEqual(result.summary, { filesChanged: 1, additions: 2, deletions: 0 });
  assert.equal(result.files[0].path, "frontend/src/NewPage.jsx");
  assert(result.files[0].hunks[0].lines.every((line) => line.type === "added"));
  assert.deepEqual(result.files[0].hunks[0].lines.map((line) => line.newLineNumber), [1, 2]);
});

test("modified text files return context, additions, deletions, and aligned numbers", async () => {
  const result = await buildCommitDiff(
    snapshot([storedFile("src/App.jsx", "old", "old-hash")]),
    snapshot([storedFile("src/App.jsx", "new", "new-hash")]),
    { readObject: memoryReader({ old: "one\ntwo\n", new: "one\nthree\n" }) },
  );
  assert.deepEqual(result.summary, { filesChanged: 1, additions: 1, deletions: 1 });
  const lines = result.files[0].hunks[0].lines;
  assert(lines.some((line) => line.type === "context" && line.oldLineNumber === 1 && line.newLineNumber === 1));
  assert(lines.some((line) => line.type === "removed" && line.oldLineNumber === 2 && line.newLineNumber === null));
  assert(lines.some((line) => line.type === "added" && line.oldLineNumber === null && line.newLineNumber === 2));
});

test("deleted files contain only removed lines", async () => {
  const result = await buildCommitDiff(
    snapshot([storedFile("old-config.js", "old", "old-hash")]),
    new Map(),
    { readObject: memoryReader({ old: "one\ntwo\n" }) },
  );
  assert.deepEqual(result.summary, { filesChanged: 1, additions: 0, deletions: 2 });
  assert(result.files[0].hunks[0].lines.every((line) => line.type === "removed"));
});

test("same filename in different folders remains path-distinct", async () => {
  const previous = snapshot([
    storedFile("admin/src/App.jsx", "admin-old", "admin-old"),
    storedFile("frontend/src/App.jsx", "front", "same"),
  ]);
  const current = snapshot([
    storedFile("admin/src/App.jsx", "admin-new", "admin-new"),
    storedFile("frontend/src/App.jsx", "front", "same"),
  ]);
  const result = await buildCommitDiff(previous, current, {
    readObject: memoryReader({ "admin-old": "old\n", "admin-new": "new\n" }),
  });
  assert.deepEqual(result.files.map((file) => file.path), ["admin/src/App.jsx"]);
});

test("added empty files are reported without artificial line changes", async () => {
  const result = await buildCommitDiff(new Map(), snapshot([
    storedFile("empty.txt", "empty", "empty-hash"),
  ]), { readObject: memoryReader({ empty: "" }) });
  assert.deepEqual(result.summary, { filesChanged: 1, additions: 0, deletions: 0 });
  assert.deepEqual(result.files[0].hunks, []);
});

test("binary and large files are not decoded into line diffs", async () => {
  const calls = [];
  const binary = await buildCommitDiff(new Map(), snapshot([
    storedFile("public/logo.png", "image", "image-hash"),
  ]), { readObject: memoryReader({ image: Buffer.from([0, 1, 2]) }, calls) });
  assert.equal(binary.files[0].binary, true);
  assert.equal(binary.files[0].message, "Binary file changed");
  assert.equal(calls.length, 0);

  const large = await buildCommitDiff(new Map(), snapshot([
    storedFile("large.txt", "large", "large-hash"),
  ]), { readObject: memoryReader({ large: "x".repeat(20) }), maxBytes: 10 });
  assert.equal(large.files[0].tooLarge, true);
  assert.equal(large.files[0].message, "File is too large for inline diff");
});

test("matching hashes detect a conservative rename", async () => {
  const result = await buildCommitDiff(
    snapshot([storedFile("old/name.js", "old", "same-hash")]),
    snapshot([storedFile("new/name.js", "new", "same-hash")]),
    { readObject: memoryReader({ old: "same\n", new: "same\n" }) },
  );
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].status, "renamed");
  assert.equal(result.files[0].oldPath, "old/name.js");
  assert.equal(result.files[0].path, "new/name.js");
});

test("protected environment files never read or return content", async () => {
  const calls = [];
  const result = await buildCommitDiff(new Map(), snapshot([
    storedFile("config/.env.example", "secret", "secret-hash"),
  ]), { readObject: memoryReader({ secret: "TOKEN=secret" }, calls) });
  assert.equal(result.files[0].protected, true);
  assert.equal(result.files[0].message, "Protected file diff hidden");
  assert.equal(calls.length, 0);
});

test("missing S3 objects mark only that file unavailable", async () => {
  const result = await buildCommitDiff(new Map(), snapshot([
    storedFile("missing.js", "missing", "missing-hash"),
  ]), { readObject: memoryReader({}) });
  assert.equal(result.files[0].unavailable, true);
  assert.match(result.files[0].message, /unavailable/i);
});

test("commits with no file changes return an empty summary without reads", async () => {
  const calls = [];
  const file = storedFile("same.txt", "same", "same-hash");
  const result = await buildCommitDiff(snapshot([file]), snapshot([file]), {
    readObject: memoryReader({ same: "unchanged" }, calls),
  });
  assert.deepEqual(result.summary, { filesChanged: 0, additions: 0, deletions: 0 });
  assert.deepEqual(result.files, []);
  assert.equal(calls.length, 0);
});

test("snapshot reconstruction supports legacy IDs, incremental commits, and missing parents", () => {
  const repository = {
    _id: "repository-id",
    commits: [
      { _id: null, message: "Legacy", files: [storedFile("src/App.js", "v1", "one")] },
      {
        hash: "second",
        files: [
          { ...storedFile("src/App.js", "v2", "two"), status: "modified" },
          { ...storedFile("nested/new.js", "new", "new"), status: "added" },
        ],
        deletedFiles: [],
      },
      {
        hash: "modern-metadata",
        storageId: "storage-modern",
        files: [{ filename: "App.js", path: "src/App.js", hash: "three" }],
      },
      {
        hash: "third",
        parent: "missing-parent",
        snapshot: [storedFile("only.txt", "only", "only")],
      },
    ],
  };
  const legacy = findCommitDescriptor(repository, "legacy-1");
  assert(legacy);
  assert.deepEqual([...reconstructSnapshot(repository, legacy).keys()], ["src/App.js"]);

  const second = findCommitDescriptor(repository, "second");
  assert.deepEqual([...reconstructSnapshot(repository, second).keys()].sort(), ["nested/new.js", "src/App.js"]);

  const modern = reconstructSnapshot(repository, findCommitDescriptor(repository, "modern-metadata"));
  assert.deepEqual([...modern.keys()].sort(), ["nested/new.js", "src/App.js"]);
  assert.equal(modern.get("src/App.js").contentUnavailable, true);

  const third = findCommitDescriptor(repository, "third");
  assert.equal(getParentCommitDescriptor(repository, third).missingParent, "missing-parent");
  assert.deepEqual([...reconstructSnapshot(repository, third).keys()], ["only.txt"]);
});

test("S3 reader caches both successful and missing objects per request", async () => {
  let requests = 0;
  const s3 = {
    getObject: ({ Key }) => ({ promise: async () => {
      requests += 1;
      if (Key === "missing") throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return { Body: Buffer.from("value"), ContentType: "text/plain" };
    } }),
  };
  const reader = createS3ObjectReader(s3, "bucket", new Map());
  await reader({ s3Key: "same" });
  await reader({ s3Key: "same" });
  const missingOne = await reader({ s3Key: "missing" });
  const missingTwo = await reader({ s3Key: "missing" });
  assert.equal(requests, 2);
  assert.equal(missingOne.available, false);
  assert.equal(missingTwo.available, false);
});

test("diff controller validates identifiers and preserves private access errors", async () => {
  const accessPath = require.resolve("../utils/repositoryAccess");
  const awsPath = require.resolve("../config/aws-config");
  const controllerPath = require.resolve("../controllers/diffController");
  const originalAccess = require.cache[accessPath];
  const originalAws = require.cache[awsPath];
  let accessError = null;
  require.cache[accessPath] = {
    id: accessPath,
    filename: accessPath,
    loaded: true,
    exports: {
      getAccessibleRepository: async () => {
        if (accessError) throw accessError;
        return { _id: "repo", commits: [], content: [] };
      },
      sendAccessError: (res, error) => res.status(error.status || 500).json({ error: error.message }),
    },
  };
  require.cache[awsPath] = {
    id: awsPath,
    filename: awsPath,
    loaded: true,
    exports: {
      s3: { getObject: () => ({ promise: async () => ({ Body: Buffer.alloc(0) }) }) },
      S3_BUCKET: "test-bucket",
    },
  };
  delete require.cache[controllerPath];
  const { getCommitDiff } = require("../controllers/diffController");
  const response = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  const invalid = response();
  await getCommitDiff({ params: { id: "repo", commitId: "../bad" } }, invalid);
  assert.equal(invalid.statusCode, 400);

  accessError = Object.assign(new Error("Authentication required"), { status: 401 });
  const privateResponse = response();
  await getCommitDiff({ params: { id: "repo", commitId: "valid-commit" } }, privateResponse);
  assert.equal(privateResponse.statusCode, 401);
  assert.equal(privateResponse.body.error, "Authentication required");

  accessError = null;
  const missingCommit = response();
  await getCommitDiff({ params: { id: "repo", commitId: "valid-commit" } }, missingCommit);
  assert.equal(missingCommit.statusCode, 404);

  delete require.cache[controllerPath];
  if (originalAccess) require.cache[accessPath] = originalAccess;
  else delete require.cache[accessPath];
  if (originalAws) require.cache[awsPath] = originalAws;
  else delete require.cache[awsPath];
});
