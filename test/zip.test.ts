import { describe, it, expect } from "vitest";
import { buildZip, type ZipEntry } from "../src/util/zip.js";
import { crc32 } from "../src/util/crc32.js";

describe("crc32", () => {
  it("标准测试向量", () => {
    expect(crc32(Buffer.from(""))).toBe(0x00000000);
    expect(crc32(Buffer.from("a"))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("中文内容"))).toBeGreaterThan(0);
  });
});

describe("buildZip（STORE）", () => {
  const entries: ZipEntry[] = [
    { name: "a.png", data: Buffer.from([1, 2, 3]) },
    { name: "dir/b.png", data: Buffer.from("hello png") },
  ];
  const zip = buildZip(entries);

  it("EOCD 签名与条目数", () => {
    const eocd = zip.subarray(zip.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(8)).toBe(2); // 本卷条目数
    expect(eocd.readUInt16LE(10)).toBe(2); // 总条目数
    expect(eocd.readUInt32LE(16)).toBe(zip.length - 22 - eocd.readUInt32LE(12)); // offset 一致
  });

  it("本地文件头签名、CRC 与数据正确", () => {
    let off = 0;
    for (const e of entries) {
      expect(zip.readUInt32LE(off)).toBe(0x04034b50);
      expect(zip.readUInt16LE(off + 8)).toBe(0); // STORE
      expect(zip.readUInt32LE(off + 14)).toBe(crc32(e.data));
      const nameLen = zip.readUInt16LE(off + 26);
      const name = zip.subarray(off + 30, off + 30 + nameLen).toString("utf8");
      expect(name).toBe(e.name);
      const dataStart = off + 30 + nameLen;
      expect(zip.subarray(dataStart, dataStart + e.data.length).equals(e.data)).toBe(true);
      off = dataStart + e.data.length;
    }
  });

  it("中央目录包含全部条目名", () => {
    const eocd = zip.subarray(zip.length - 22);
    const cdSize = eocd.readUInt32LE(12);
    const cdStart = zip.length - 22 - cdSize;
    let off = cdStart;
    const names: string[] = [];
    while (zip.readUInt32LE(off) === 0x02014b50) {
      const nameLen = zip.readUInt16LE(off + 28);
      names.push(zip.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
      off += 46 + nameLen;
    }
    expect(names).toEqual(["a.png", "dir/b.png"]);
  });

  it("空条目列表生成合法空 zip", () => {
    const empty = buildZip([]);
    const eocd = empty.subarray(empty.length - 22);
    expect(eocd.readUInt16LE(8)).toBe(0);
    expect(empty.length).toBe(22);
  });
});
