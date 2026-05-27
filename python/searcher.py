#!/usr/bin/env python3
"""
PBOTS 圖紙搜尋引擎 — drawins.db 關鍵字查詢
============================================

供 Node.js WhatsApp Bot 以 child_process 呼叫，輸出 JSON。

用法：
    python searcher.py --query "AL_PL"                      # 基本搜尋
    python searcher.py --query "AL_PL" --prefix "FST"       # 限 FST 開頭
    python searcher.py --query "AL_PL" --limit 10           # 上限 10 筆
    python searcher.py --query "AL_PL" --db "./drawins.db"  # 指定 DB 路徑
"""

import argparse
import json
import sqlite3
import sys
from typing import Optional


class SearchEngine:
    """drawins.db 搜尋引擎，封裝連線與查詢邏輯。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    def search(self, keyword: str, prefix: Optional[str] = None,
               limit: int = 0) -> dict:
        """
        關鍵字搜尋，回傳結構化結果。

        參數：
            keyword: 搜尋關鍵字（LIKE %keyword%）
            prefix:  可選物料碼前綴（LIKE prefix%）
            limit:   回傳上限，0 = 無限制

        回傳：
            {
                "status": "success" | "error",
                "data": [{"filename": "...", ...}],
                "total": 12,
                "db": "drawins.db"
            }
        """
        try:
            conn = sqlite3.connect(self.db_path)
            conn.execute("PRAGMA query_only=ON;")  # 唯讀防呆
            cur = conn.cursor()
        except sqlite3.Error as exc:
            return {"status": "error", "message": f"無法開啟資料庫: {exc}"}

        # 建構查詢
        conditions = ["extracted_text LIKE ?"]
        params = [f"%{keyword}%"]

        if prefix:
            conditions.append("filename LIKE ?")
            params.append(f"{prefix}%")  # 用 append，唔係 insert(0,)

        sql = (
            "SELECT filename, file_path, extracted_text, text_count, updated_at "
            "FROM drawing_index WHERE " + " AND ".join(conditions) +
            " ORDER BY text_count DESC, updated_at DESC"
        )

        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)

        try:
            cur.execute(sql, params)
            rows = cur.fetchall()
        except sqlite3.Error as exc:
            conn.close()
            return {"status": "error", "message": f"查詢失敗: {exc}"}

        data = []
        for r in rows:
            filename, file_path, extracted_text, text_count, updated_at = r

            # 從 extracted_text 中擷取包含關鍵字的行作為摘要
            snippet_lines = []
            if extracted_text:
                for line in extracted_text.split("\n"):
                    if keyword.lower() in line.lower():
                        snippet_lines.append(line.strip())
                    if len(snippet_lines) >= 5:  # 最多 5 行摘要
                        break

            data.append({
                "filename": filename,
                "file_path": file_path,
                "text_count": text_count,
                "updated_at": updated_at,
                "snippet": snippet_lines,
                "snippet_count": len(snippet_lines),
            })

        conn.close()
        return {
            "status": "success",
            "data": data,
            "total": len(data),
            "db": self.db_path,
        }

    def list_prefixes(self) -> dict:
        """
        列出所有已索引嘅物料碼前綴（支援自動補全建議）。

        回傳：
            {"status": "success", "prefixes": ["FST", "FAC", "BGL", ...]}
        """
        try:
            conn = sqlite3.connect(self.db_path)
            cur = conn.cursor()
            cur.execute(
                "SELECT DISTINCT SUBSTR(filename, 1, 3) AS prefix "
                "FROM drawing_index WHERE filename GLOB '[A-Z][A-Z][A-Z]*' "
                "ORDER BY prefix"
            )
            prefixes = [r[0] for r in cur.fetchall()]
            conn.close()
            return {"status": "success", "prefixes": prefixes}
        except sqlite3.Error as exc:
            return {"status": "error", "message": str(exc)}

    def stats(self) -> dict:
        """資料庫統計資訊。"""
        try:
            conn = sqlite3.connect(self.db_path)
            cur = conn.cursor()
            total = cur.execute("SELECT COUNT(*) FROM drawing_index").fetchone()[0]
            total_text = cur.execute(
                "SELECT COALESCE(SUM(text_count), 0) FROM drawing_index"
            ).fetchone()[0]
            updated = cur.execute(
                "SELECT MAX(updated_at) FROM drawing_index"
            ).fetchone()[0]
            conn.close()
            return {
                "status": "success",
                "total_drawings": total,
                "total_text_objects": total_text,
                "last_updated": updated,
            }
        except sqlite3.Error as exc:
            return {"status": "error", "message": str(exc)}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="PBOTS 圖紙搜尋引擎",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--db", default="drawings.db",
                        help="SQLite 資料庫路徑（預設: drawins.db）")
    parser.add_argument("--query", help="搜尋關鍵字")
    parser.add_argument("--prefix", help="物料碼前綴過濾（如 FST, FAC）")
    parser.add_argument("--limit", type=int, default=0,
                        help="回傳上限，0=無限制（預設: 0）")
    parser.add_argument("--prefixes", action="store_true",
                        help="列出所有物料碼前綴")
    parser.add_argument("--stats", action="store_true", help="資料庫統計")
    args = parser.parse_args()

    engine = SearchEngine(args.db)

    # 優先處理 metadata 查詢
    if args.prefixes:
        result = engine.list_prefixes()
    elif args.stats:
        result = engine.stats()
    elif args.query:
        result = engine.search(args.query, args.prefix, args.limit)
    else:
        # 無參數時回傳統計
        result = engine.stats()
        result["hint"] = "可用 --query 搜尋關鍵字，--prefix 過濾物料碼"

    # stdout 輸出 JSON（Node.js child_process 讀取）
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # 發生錯誤時 stderr 也留記錄
    if result.get("status") == "error":
        print(result["message"], file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
