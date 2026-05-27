#!/usr/bin/env python3
"""
PBOTS 圖紙提取引擎 — DWG/DXF → SQLite 索引
==============================================

支援兩種後端:
  1. .dxf → ezdxf（跨平台，推薦）
  2. .dwg → win32com + AutoCAD（Windows 限定，需安裝 AutoCAD）

若 .dwg 無法使用 COM，可先用 ODA File Converter 批次轉 .dxf 再餵給 ezdxf。

用法：
    python extractor.py --input "C:/POR_Drawings" --db "drawings.db"
"""

import argparse
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# 日誌設定 — console + error.log
# ---------------------------------------------------------------------------
logger = logging.getLogger("extractor")
logger.setLevel(logging.DEBUG)

_fh = logging.FileHandler("error.log", encoding="utf-8")
_fh.setLevel(logging.ERROR)
_fh.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s | %(message)s"))

_ch = logging.StreamHandler(sys.stdout)
_ch.setLevel(logging.INFO)
_ch.setFormatter(logging.Formatter("%(levelname)-8s | %(message)s"))

logger.addHandler(_fh)
logger.addHandler(_ch)


# ---------------------------------------------------------------------------
# SQLite 管理器
# ---------------------------------------------------------------------------
class DatabaseManager:
    """SQLite 資料庫封裝，自動啟用 WAL 模式及建立索引。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn: Optional[sqlite3.Connection] = None

    def open(self):
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("PRAGMA journal_mode=WAL;")       # 並發讀寫效能
        self.conn.execute("PRAGMA synchronous=NORMAL;")     # 平衡安全與速度
        self.conn.execute("PRAGMA cache_size=-64000;")       # 64 MB 快取
        self._create_schema()

    def _create_schema(self):
        cur = self.conn.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS drawing_index (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                filename        TEXT    NOT NULL UNIQUE,
                file_path       TEXT,
                file_size       INTEGER,
                extracted_text  TEXT,
                text_count      INTEGER DEFAULT 0,
                updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_drawing_filename
                ON drawing_index(filename);

            CREATE INDEX IF NOT EXISTS idx_drawing_updated
                ON drawing_index(updated_at);
        """)
        self.conn.commit()

    def upsert(self, filename: str, file_path: str, file_size: int,
               extracted_text: str, text_count: int):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.conn.execute("""
            INSERT INTO drawing_index(filename, file_path, file_size,
                                      extracted_text, text_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
                file_path      = excluded.file_path,
                file_size      = excluded.file_size,
                extracted_text = excluded.extracted_text,
                text_count     = excluded.text_count,
                updated_at     = excluded.updated_at;
        """, (filename, file_path, file_size, extracted_text, text_count, now))
        self.conn.commit()

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM drawing_index").fetchone()[0]

    def close(self):
        if self.conn:
            self.conn.close()


# ---------------------------------------------------------------------------
# ezdxf 提取器（跨平台，僅限 .dxf）
# ---------------------------------------------------------------------------
def _safe_attrib_text(attrib) -> tuple[str, str]:
    """安全提取單一 ATTRIB 嘅 (tag, text)。兼容 ezdxf 各版本。"""
    if hasattr(attrib, 'dxf'):
        return attrib.dxf.tag, attrib.dxf.text
    if isinstance(attrib, (tuple, list)) and len(attrib) >= 2:
        return str(attrib[0]), str(attrib[1]) if attrib[1] else ""
    return "", ""


def extract_dxf_ezdxf(filepath: str) -> tuple[str, int]:
    """
    使用 ezdxf 提取 .dxf 內容。
    涵蓋：ModelSpace TEXT/MTEXT、BlockRef ATTRIB、
          Block 定義內 ATTDEF/TEXT/MTEXT、巢狀 Block。
    回傳 (all_text, text_count)，失敗時回傳 ("", 0)。
    """
    import ezdxf

    doc = ezdxf.readfile(filepath)
    texts: list[str] = []

    msp = doc.modelspace()

    # ── 1. ModelSpace 直接 TEXT / MTEXT ────────────────────────────
    for e in msp.query("TEXT MTEXT"):
        raw = e.dxf.text if e.dxftype() == "TEXT" else e.text
        if raw and raw.strip():
            texts.append(f"[MSP:{e.dxf.layer}] {raw.strip()}")

    # ── 2. INSERT (BlockReference) ──────────────────────────────────
    for br in msp.query("INSERT"):
        block_name = br.dxf.name

        # 2a. 直接 ATTRIB 文字（ezdxf 各版本兼容迭代）
        attrib_count = 0
        try:
            for attrib in br.attribs:
                tag, val = _safe_attrib_text(attrib)
                if val and val.strip():
                    texts.append(
                        f"[BLK:{block_name} TAG:{tag}] {val.strip()}"
                    )
                    attrib_count += 1
        except Exception:
            pass

        # 2b. Fallback：如果 INSERT 冇 ATTRIB，讀取 Block 定義入面
        #     嘅 ATTDEF 預設值（常見於未填屬性值嘅位置圖）
        if attrib_count == 0:
            try:
                blk_def = doc.blocks.get(block_name)
                for e in blk_def.query("ATTDEF"):
                    tag = e.dxf.tag
                    val = e.dxf.text
                    if val and val.strip():
                        texts.append(
                            f"[BLK:{block_name} ATTDEF_TAG:{tag}] {val.strip()}"
                        )
            except Exception:
                pass

        # 2c. 遞迴處理巢狀 Block（ATTRIB + TEXT/MTEXT + ATTDEF）
        _extract_nested_block_texts(doc, block_name, texts, set())

    # ── 3. PaperSpace Layouts（預設不啟用） ────────────────────────
    # 如需啟用，取消下方註解：
    # for layout in doc.layouts():
    #     if layout.name == "Model":
    #         continue
    #     for e in layout.query("TEXT MTEXT"):
    #         raw = e.dxf.text if e.dxftype() == "TEXT" else e.text
    #         if raw and raw.strip():
    #             texts.append(f"[{layout.name}:{e.dxf.layer}] {raw.strip()}")

    full_text = "\n".join(texts)
    return full_text, len(texts)


def _extract_nested_block_texts(doc, block_name: str, texts: list,
                                visited: set, depth: int = 0):
    """遞迴解析巢狀 Block 內所有文字：TEXT、MTEXT、ATTDEF、ATTRIB、子 INSERT。"""
    if depth > 15 or block_name in visited:
        return
    visited.add(block_name)

    try:
        blk = doc.blocks.get(block_name)
    except KeyError:
        return

    for e in blk:
        dtype = e.dxftype()
        if dtype in ("TEXT", "MTEXT"):
            raw = e.dxf.text if dtype == "TEXT" else e.text
            if raw and raw.strip():
                texts.append(
                    f"[BLK:{block_name}:{e.dxf.layer}] {raw.strip()}"
                )
        elif dtype == "ATTDEF":
            tag = e.dxf.tag
            val = e.dxf.text
            if val and val.strip():
                texts.append(
                    f"[BLK:{block_name} ATTDEF_TAG:{tag}] {val.strip()}"
                )
        elif dtype == "INSERT":
            # 巢狀 INSERT → 先提取佢嘅 ATTRIB，再遞迴
            try:
                for attrib in e.attribs:
                    tag, val = _safe_attrib_text(attrib)
                    if val and val.strip():
                        texts.append(
                            f"[BLK:{block_name}>{e.dxf.name} TAG:{tag}] {val.strip()}"
                        )
            except Exception:
                pass
            _extract_nested_block_texts(
                doc, e.dxf.name, texts, visited, depth + 1
            )


# ---------------------------------------------------------------------------
# win32com 提取器（Windows + AutoCAD，支援 .dwg）
# ---------------------------------------------------------------------------
def extract_dwg_com(filepath: str) -> tuple[str, int]:
    """
    使用 win32com + AutoCAD COM 介面提取 .dwg 內容。
    回傳 (all_text, text_count)，失敗時回傳 ("", 0)。

    注意：AutoCAD 必須已安裝授權，且執行期間會被 COM 喚起。
    """
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()

    texts: list[str] = []
    acad = win32com.client.Dispatch("AutoCAD.Application")
    # 設為不可見，避免視窗閃爍
    acad.Visible = False

    doc = None
    try:
        # 若檔案已在 AutoCAD 開啟，Open() 會拋錯，先用 try 保護
        doc = acad.Documents.Open(os.path.abspath(filepath))

        # ── ModelSpace ──────────────────────────────────────────────
        msp = doc.ModelSpace
        for ent in msp:
            try:
                name = ent.EntityName
                if name == "AcDbText":
                    txt = ent.TextString
                    if txt and txt.strip():
                        texts.append(f"[MSP:{ent.Layer}] {txt.strip()}")

                elif name == "AcDbMText":
                    txt = ent.TextString
                    if txt and txt.strip():
                        texts.append(f"[MSP:{ent.Layer}] {txt.strip()}")

                elif name == "AcDbBlockReference":
                    block_name = ent.Name
                    # 讀取 HasAttributes → GetAttributes
                    if ent.HasAttributes:
                        for attrib in ent.GetAttributes():
                            tag = attrib.TagString
                            val = attrib.TextString
                            if val and val.strip():
                                texts.append(
                                    f"[BLK:{block_name} TAG:{tag}] {val.strip()}"
                                )
            except Exception:
                # 單一實體失敗不中斷
                continue

    except Exception as exc:
        raise RuntimeError(f"AutoCAD COM 讀取失敗: {exc}") from exc
    finally:
        if doc is not None:
            try:
                doc.Close(False)  # False = 不儲存變更
            except Exception:
                pass
        try:
            acad.Quit()
        except Exception:
            pass
        pythoncom.CoUninitialize()

    full_text = "\n".join(texts)
    return full_text, len(texts)


# ---------------------------------------------------------------------------
# ODA File Converter 輔助（批次 .dwg → .dxf）
# ---------------------------------------------------------------------------
def dwg_to_dxf_batch(input_dir: str, output_dir: str,
                      odaconv_path: str = "ODAFileConverter.exe") -> list[str]:
    """
    呼叫 ODA File Converter 命令列，批次轉換 .dwg → .dxf。

    參數：
        input_dir   : 原始 .dwg 目錄（含子目錄）
        output_dir  : 輸出 .dxf 目錄（保持相同子目錄結構）
        odaconv_path: ODAFileConverter.exe 路徑

    回傳已轉換的 .dxf 路徑清單。
    """
    import subprocess

    os.makedirs(output_dir, exist_ok=True)
    # ODA 參數說明：
    #   /r  遞迴子目錄  /f ACAD2018  /of DXF  /v R18  /q 安靜模式
    cmd = [
        odaconv_path,
        os.path.abspath(input_dir),
        os.path.abspath(output_dir),
        "ACAD2018", "DXF", "R18",
        "/r", "/q",
    ]
    logger.info("執行 ODA 轉換: %s", " ".join(cmd))

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        logger.error("ODA 轉換失敗: %s", result.stderr)
        return []

    converted = list(Path(output_dir).rglob("*.dxf"))
    logger.info("ODA 轉換完成: %d 個 .dxf 檔案", len(converted))
    return [str(p) for p in converted]


# ---------------------------------------------------------------------------
# 主調度器
# ---------------------------------------------------------------------------
class ExtractorEngine:
    """統一調度 .dwg / .dxf 提取流程。"""

    # AutoCAD 支援的檔案副檔名（.dwt = 樣板，仍可讀取）
    COM_EXTENSIONS = {".dwg", ".dwt"}

    def __init__(self, db: DatabaseManager, input_dir: str,
                 use_com: bool = False, odaconv_path: str = None):
        self.db = db
        self.input_dir = input_dir
        self.use_com = use_com
        self.odaconv_path = odaconv_path
        self.processed = 0
        self.skipped = 0
        self.errors = 0

    def run(self):
        """掃描 input_dir，提取所有 .dwg/.dxf 文件並寫入資料庫。"""
        start = time.time()
        logger.info("開始提取 → input: %s | db: %s", self.input_dir, self.db.db_path)

        # ── 收集檔案 ────────────────────────────────────────────────
        all_files = list(Path(self.input_dir).rglob("*.dwg"))
        all_files.extend(Path(self.input_dir).rglob("*.dxf"))
        all_files.extend(Path(self.input_dir).rglob("*.dwt"))

        # 按副檔名分類
        dwg_files = [f for f in all_files if f.suffix.lower() in {".dwg", ".dwt"}]
        dxf_files = [f for f in all_files if f.suffix.lower() == ".dxf"]

        # ── 若 .dwg 很多且不啟用 COM，先批次轉 .dxf ────────────────
        if dwg_files and not self.use_com:
            logger.warning(
                "發現 %d 個 .dwg 檔案但未啟用 COM（use_com=False）。"
                " 略過 .dwg，僅處理現有 .dxf。",
                len(dwg_files),
            )
            logger.warning(
                "建議：\n"
                "  1) 設定 use_com=True 直接讀取（需 AutoCAD）\n"
                "  2) 先用 ODA File Converter 轉 .dxf，再執行本腳本\n"
            )

        # ── 處理每個檔案 ─────────────────────────────────────────────
        for fp in all_files:
            ext = fp.suffix.lower()
            # .dwg / .dwt 交由 COM 處理（若啟用），否則跳過
            if ext in self.COM_EXTENSIONS:
                if not self.use_com:
                    self.skipped += 1
                    continue
                self._process_one(str(fp), extractor=extract_dwg_com)
            else:
                # .dxf 使用 ezdxf
                self._process_one(str(fp), extractor=extract_dxf_ezdxf)

        elapsed = time.time() - start
        logger.info(
            "✅ 完成！已處理: %d | 略過: %d | 錯誤: %d | 耗時: %.1f 秒",
            self.processed, self.skipped, self.errors, elapsed,
        )
        logger.info("資料庫總筆數: %d", self.db.count())

    def _process_one(self, filepath: str, extractor):
        """提取單一檔案並寫入資料庫。"""
        fname = os.path.basename(filepath)
        fsize = os.path.getsize(filepath)

        try:
            text, count = extractor(filepath)
            self.db.upsert(
                filename=fname,
                file_path=os.path.abspath(filepath),
                file_size=fsize,
                extracted_text=text,
                text_count=count,
            )
            logger.info("  ✓ %s (%d 個文字物件)", fname, count)
            self.processed += 1
        except Exception as exc:
            logger.error("  ✗ %s — %s", fname, exc)
            self.errors += 1
            # 將失敗記錄寫入 error.log
            logging.getLogger("extractor").error(
                "檔案: %s | 大小: %d | 錯誤: %s", filepath, fsize, exc
            )

    def summary_report(self) -> str:
        return (
            f"處理: {self.processed} | 略過: {self.skipped} | 錯誤: {self.errors}"
        )


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="PBOTS 圖紙提取引擎 — DWG/DXF → SQLite 索引",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "範例:\n"
            "  # 僅處理 .dxf（ezdxf，跨平台）\n"
            "  python extractor.py --input C:/POR_Drawings --db drawings.db\n\n"
            "  # 啟用 COM 讀取 .dwg（需 AutoCAD + pywin32）\n"
            "  python extractor.py --input C:/POR_Drawings --db drawings.db --com\n\n"
            "  # 先用 ODA 轉換，再索引（推薦 .dwg 工作流）\n"
            "  python odaconvert.py --input C:/POR_Drawings --output C:/DXF_Output\n"
            "  python extractor.py --input C:/DXF_Output --db drawings.db\n"
        ),
    )
    parser.add_argument("--input", required=True, help="圖紙根目錄")
    parser.add_argument("--db", default="drawings.db", help="SQLite 資料庫路徑")
    parser.add_argument("--com", action="store_true",
                        help="啟用 win32com (AutoCAD) 讀取 .dwg")
    parser.add_argument("--odaconv", default=None,
                        help="ODA File Converter.exe 路徑（用於批次 .dwg→.dxf）")
    args = parser.parse_args()

    # 驗證輸入路徑
    if not os.path.isdir(args.input):
        logger.error("輸入目錄不存在: %s", args.input)
        sys.exit(1)

    # 開啟資料庫
    db = DatabaseManager(args.db)
    db.open()

    try:
        engine = ExtractorEngine(
            db=db,
            input_dir=args.input,
            use_com=args.com,
            odaconv_path=args.odaconv,
        )
        engine.run()

        # 輸出摘要
        print(f"\n{'='*50}")
        print(f"  摘要: {engine.summary_report()}")
        print(f"  資料庫: {os.path.abspath(args.db)}")
        print(f"  錯誤日誌: {os.path.abspath('error.log')}")
        print(f"{'='*50}")

    finally:
        db.close()


if __name__ == "__main__":
    main()
