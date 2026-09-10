# 智慧垃圾分類回收桶 - 資料庫管理
# Smart Recycling Trash Bin - Database Manager
#
# 功能：
#   1. 封裝 SQLStore 操作，提供回收記錄的 CRUD
#   2. 支援分頁查詢、類型過濾、日期範圍過濾
#   3. 提供每日/每小時統計聚合

import time
from datetime import datetime
from arduino.app_bricks.dbstorage_sqlstore import SQLStore, DBStorageSQLStoreError

TABLE = "sort_records"


def _normalize_timestamp(value):
    """Convert date input to Unix timestamp integer.
    Accepts: int/float (already timestamp), str (YYYY-MM-DD), None
    Returns: int timestamp or None
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        # Handle YYYY-MM-DD format
        if len(value) == 10 and value[4] == '-' and value[7] == '-':
            dt = datetime.strptime(value, "%Y-%m-%d")
            return int(dt.timestamp())
        # Try parsing as integer string
        try:
            return int(value)
        except ValueError:
            return None
    return None


class DatabaseManager:
    """封裝 SQLStore 操作，提供智慧垃圾桶回收記錄的資料庫存取介面"""

    def __init__(self, db_name="recycling.db"):
        """初始化 SQLStore 實例"""
        self.store = SQLStore(db_name)

    def start(self):
        """啟動資料庫連線並建立必要的表格"""
        self.store.start()
        # 確保 sort_records 表格存在（id 自動遞增主鍵）
        self.store.execute_sql(
            f"CREATE TABLE IF NOT EXISTS {TABLE} ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "type TEXT NOT NULL, "
            "timestamp INTEGER NOT NULL, "
            "confidence REAL"
            ")",
            ()
        )

    def stop(self):
        """關閉資料庫連線"""
        self.store.stop()

    def insert_record(self, trash_type: str, confidence: float = None) -> int:
        """
        插入一筆回收記錄

        Args:
            trash_type: "plastic" 或 "paper"
            confidence: AI 辨識信心值 (0.0 ~ 1.0)，可為 None

        Returns:
            新插入記錄的 id
        """
        try:
            result = self.store.store(TABLE, {
                "type": trash_type,
                "timestamp": int(time.time()),
                "confidence": confidence
            }, create_table=False)
            # SQLStore.store 返回最後插入的 rowid
            return result if result is not None else 0
        except DBStorageSQLStoreError as e:
            print(f"[DB] insert_record failed: {e}", flush=True)
            return 0

    def get_records(self, page=1, per_page=10, type_filter=None, date_from=None, date_to=None) -> list:
        """
        分頁查詢回收記錄（最新優先）

        Args:
            page: 頁碼（從 1 開始）
            per_page: 每頁筆數
            type_filter: "plastic" / "paper" / None（全部）
            date_from: 起始時間戳（Unix epoch），None 表示不限制
            date_to: 結束時間戳（Unix epoch），None 表示不限制

        Returns:
            list[dict] 包含 id, type, timestamp, confidence
        """
        try:
            conditions = []
            args = []

            if type_filter:
                conditions.append("type = ?")
                args.append(type_filter)
            if date_from is not None:
                ts = _normalize_timestamp(date_from)
                if ts is not None:
                    conditions.append("timestamp >= ?")
                    args.append(ts)
            if date_to is not None:
                ts = _normalize_timestamp(date_to)
                if ts is not None:
                    conditions.append("timestamp <= ?")
                    args.append(ts)

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            offset = (page - 1) * per_page
            sql = f"SELECT id, type, timestamp, confidence FROM {TABLE} {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?"
            args.extend([per_page, offset])

            rows = self.store.execute_sql(sql, tuple(args))
            return rows if rows else []
        except DBStorageSQLStoreError as e:
            print(f"[DB] get_records failed: {e}", flush=True)
            return []

    def get_record_count(self, type_filter=None, date_from=None, date_to=None) -> dict:
        """
        取得記錄計數

        Args:
            type_filter: "plastic" / "paper" / None（全部）
            date_from: 起始時間戳
            date_to: 結束時間戳

        Returns:
            {"plastic": N, "paper": N, "total": N}
        """
        try:
            conditions = []
            args = []

            if date_from is not None:
                ts = _normalize_timestamp(date_from)
                if ts is not None:
                    conditions.append("timestamp >= ?")
                    args.append(ts)
            if date_to is not None:
                ts = _normalize_timestamp(date_to)
                if ts is not None:
                    conditions.append("timestamp <= ?")
                    args.append(ts)

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            # 取得總數
            total_sql = f"SELECT COUNT(*) as cnt FROM {TABLE} {where}"
            total_rows = self.store.execute_sql(total_sql, tuple(args))
            total = total_rows[0]["cnt"] if total_rows else 0

            # 取得塑膠計數
            plastic_where = where
            plastic_args = list(args)
            if type_filter != "plastic":
                if plastic_where:
                    plastic_where += " AND type = ?"
                else:
                    plastic_where = "WHERE type = ?"
                plastic_args.append("plastic")

            plastic_sql = f"SELECT COUNT(*) as cnt FROM {TABLE} {plastic_where}"
            plastic_rows = self.store.execute_sql(plastic_sql, tuple(plastic_args))
            plastic = plastic_rows[0]["cnt"] if plastic_rows else 0

            # 取得紙杯計數
            paper_where = where
            paper_args = list(args)
            if type_filter != "paper":
                if paper_where:
                    paper_where += " AND type = ?"
                else:
                    paper_where = "WHERE type = ?"
                paper_args.append("paper")

            paper_sql = f"SELECT COUNT(*) as cnt FROM {TABLE} {paper_where}"
            paper_rows = self.store.execute_sql(paper_sql, tuple(paper_args))
            paper = paper_rows[0]["cnt"] if paper_rows else 0

            return {"plastic": plastic, "paper": paper, "total": total}
        except DBStorageSQLStoreError as e:
            print(f"[DB] get_record_count failed: {e}", flush=True)
            return {"plastic": 0, "paper": 0, "total": 0}

    def get_daily_counts(self, date_from=None, date_to=None) -> list:
        """
        取得每日回收計數

        Args:
            date_from: 起始時間戳
            date_to: 結束時間戳

        Returns:
            list[dict] 包含 date ("YYYY-MM-DD"), plastic, paper, total
        """
        try:
            conditions = []
            args = []

            if date_from is not None:
                ts = _normalize_timestamp(date_from)
                if ts is not None:
                    conditions.append("timestamp >= ?")
                    args.append(ts)
            if date_to is not None:
                ts = _normalize_timestamp(date_to)
                if ts is not None:
                    conditions.append("timestamp <= ?")
                    args.append(ts)

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            sql = (
                f"SELECT "
                f"  date(timestamp, 'unixepoch') as date, "
                f"  SUM(CASE WHEN type = 'plastic' THEN 1 ELSE 0 END) as plastic, "
                f"  SUM(CASE WHEN type = 'paper' THEN 1 ELSE 0 END) as paper, "
                f"  COUNT(*) as total "
                f"FROM {TABLE} {where} "
                f"GROUP BY date ORDER BY date DESC"
            )

            rows = self.store.execute_sql(sql, tuple(args))
            return rows if rows else []
        except DBStorageSQLStoreError as e:
            print(f"[DB] get_daily_counts failed: {e}", flush=True)
            return []

    def get_hourly_distribution(self, date=None) -> list:
        """
        取得每小時回收分佈

        Args:
            date: "YYYY-MM-DD" 格式日期，None 表示全部日期

        Returns:
            list[dict] 包含 hour (0-23), plastic, paper
        """
        try:
            conditions = []
            args = []

            if date is not None:
                # 將日期轉換為當天的起始和結束時間戳
                from datetime import datetime, timedelta
                dt = datetime.strptime(date, "%Y-%m-%d")
                start_ts = int(dt.timestamp())
                end_ts = int((dt + timedelta(days=1)).timestamp()) - 1
                conditions.append("timestamp >= ?")
                args.append(start_ts)
                conditions.append("timestamp <= ?")
                args.append(end_ts)

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            sql = (
                f"SELECT "
                f"  CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) as hour, "
                f"  SUM(CASE WHEN type = 'plastic' THEN 1 ELSE 0 END) as plastic, "
                f"  SUM(CASE WHEN type = 'paper' THEN 1 ELSE 0 END) as paper "
                f"FROM {TABLE} {where} "
                f"GROUP BY hour ORDER BY hour"
            )

            rows = self.store.execute_sql(sql, tuple(args))
            return rows if rows else []
        except DBStorageSQLStoreError as e:
            print(f"[DB] get_hourly_distribution failed: {e}", flush=True)
            return []

    def delete_all(self):
        """清除所有回收記錄"""
        try:
            self.store.execute_sql(f"DELETE FROM {TABLE}", ())
        except DBStorageSQLStoreError as e:
            print(f"[DB] delete_all failed: {e}", flush=True)
