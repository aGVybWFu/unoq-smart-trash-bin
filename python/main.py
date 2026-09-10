# 智慧垃圾分類回收桶 - Python 中台
# Smart Recycling Trash Bin - Python Middleware
#
# 功能：
#   1. AI 視覺偵測塑膠 (plastic_cup) 和紙杯 (paper_cup)
#   2. 自動觸發 Arduino 舵機分類
#   3. 統計收集數量並推送至前端
#   4. 冷卻時間防止重複辨識

# SPDX-FileCopyrightText: Copyright (C) ARDUINO SRL (http://www.arduino.cc)
# SPDX-License-Identifier: MPL-2.0

import time
import threading
from arduino.app_utils import App, Bridge
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.video_objectdetection import VideoObjectDetection
from db import DatabaseManager
from arduino.app_bricks.dbstorage_sqlstore import DBStorageSQLStoreError

ui = WebUI()
detection = VideoObjectDetection(confidence=0.5)

# === 全域統計變數 ===
plastic_count = 0
paper_count = 0

# === 資料庫初始化 ===
db = DatabaseManager()

# === 冷卻時間控制 ===
COOLDOWN_SECONDS = 5    # 每次分類後冷卻 5 秒，避免重複辨識
last_sort_time = 0
is_sorting = False      # 分類進行中旗標
sort_lock = threading.Lock()  # 保護 is_sorting 檢查與設定的競爭條件
sort_seq = 0            # 遞增序列號，供 Arduino 去重使用

# === 塑膠類關鍵字 ===
PLASTIC_KEYWORDS = ["plastic_cup", "plastic", "container"]
# === 紙杯類關鍵字 ===
PAPER_KEYWORDS = ["paper_cup", "paper", "mug", "cup"]


def get_time_str():
    """取得當前時間字串 HH:MM:SS"""
    return time.strftime("%H:%M:%S", time.localtime())


def push_stats():
    """推送最新統計到前端（使用記憶體計數器，避免資料庫延遲或不一致）"""
    try:
        payload = {
            "plastic": plastic_count,
            "paper": paper_count,
            "total": plastic_count + paper_count
        }
        ui.send_message("trash_stats", payload)
        print(f"[STATS] trash_stats sent OK: {payload}", flush=True)
    except Exception as e:
        print(f"[ERROR] push_stats failed: {e}", flush=True)


def do_sort(trash_type, confidence=None):
    """執行分類動作（整個函式受 Lock 保護，確保同一時間只有一個分類在進行）"""
    global plastic_count, paper_count
    global last_sort_time, is_sorting, sort_seq

    print(f"[SORT] do_sort called: trash_type='{trash_type}', confidence={confidence}", flush=True)

    with sort_lock:
        now = time.time()
        print(f"[SORT] Lock acquired. is_sorting={is_sorting}, cooldown={now - last_sort_time:.1f}s", flush=True)
        if is_sorting or (now - last_sort_time < COOLDOWN_SECONDS):
            print(f"[SKIP] do_sort blocked: is_sorting={is_sorting}, cooldown={now - last_sort_time:.1f}s", flush=True)
            return

        is_sorting = True
        seq = 0
        time_str = get_time_str()

        try:
            last_sort_time = now
            sort_seq += 1
            seq = sort_seq
            print(f"[SORT] Starting sort #{seq} for {trash_type} at {time_str}", flush=True)

            if trash_type == "plastic":
                plastic_count += 1
                print(f"[SEQ {seq}] ♻️  [{time_str}] plastic_count incremented to {plastic_count}", flush=True)
                try:
                    Bridge.call("sort_plastic", seq)
                    print(f"[SEQ {seq}] sort_plastic call completed", flush=True)
                except Exception as e:
                    print(f"[SEQ {seq}] sort_plastic call failed: {e}", flush=True)
            elif trash_type == "paper":
                paper_count += 1
                print(f"[SEQ {seq}] 📄 [{time_str}] paper_count incremented to {paper_count}", flush=True)
                try:
                    Bridge.call("sort_paper", seq)
                    print(f"[SEQ {seq}] sort_paper call completed", flush=True)
                except Exception as e:
                    print(f"[SEQ {seq}] sort_paper call failed: {e}", flush=True)
            else:
                print(f"[WARN] Unknown trash_type: '{trash_type}'", flush=True)

            print(f"[SORT] Before push_stats: plastic={plastic_count}, paper={paper_count}", flush=True)

            # 寫入資料庫
            try:
                db.insert_record(trash_type, confidence)
                print(f"[DB] insert_record succeeded for {trash_type}", flush=True)
            except Exception as e:
                print(f"[DB] insert_record failed: {e}", flush=True)

            # 推送分類事件到前端
            try:
                ui.send_message("sort_event", {
                    "type": trash_type,
                    "timestamp": int(now),
                    "confidence": confidence
                })
                print(f"[UI] sort_event sent for {trash_type}", flush=True)
            except Exception as e:
                print(f"[UI] sort_event send failed: {e}", flush=True)

            # 推送更新後的統計
            print(f"[SORT] Calling push_stats with plastic={plastic_count}, paper={paper_count}", flush=True)
            push_stats()

        finally:
            # 保險：無論中間任何步驟（包括 Bridge.call 拋出 BaseException）導致中斷，
            # 都在 5 秒後解鎖，避免 is_sorting 永遠卡死；同時保險推送統計一次
            print(f"[SORT] finally block reached for seq={seq}, ensuring cleanup", flush=True)
            try:
                push_stats()
                print(f"[SORT] Insurance push_stats sent from finally", flush=True)
            except Exception as e:
                print(f"[SORT] Insurance push_stats failed: {e}", flush=True)

            def _unlock_sort():
                global is_sorting
                is_sorting = False
                print("[LOCK] is_sorting unlocked", flush=True)
            threading.Timer(5.0, _unlock_sort).start()
            print("[LOCK] is_sorting locked for 5s (cleanup in finally)", flush=True)


def extract_detection_bboxes(detections):
    """從 VideoObjectDetection 結果中提取邊界框與信心度"""
    results = []
    for obj, items in detections.items():
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            entry = {"label": obj}
            conf = item.get("confidence")
            if conf is not None:
                entry["confidence"] = conf

            bbox = None
            if all(k in item for k in ("x", "y", "width", "height")):
                bbox = {k: float(item[k]) for k in ("x", "y", "width", "height")}
            elif all(k in item for k in ("xmin", "ymin", "xmax", "ymax")):
                bbox = {
                    "x": float(item["xmin"]),
                    "y": float(item["ymin"]),
                    "width": float(item["xmax"]) - float(item["xmin"]),
                    "height": float(item["ymax"]) - float(item["ymin"])
                }
            elif "bbox" in item:
                b = item["bbox"]
                if isinstance(b, (list, tuple)) and len(b) >= 4:
                    bbox = {"x": float(b[0]), "y": float(b[1]),
                            "width": float(b[2]), "height": float(b[3])}
            elif all(k in item for k in ("left", "top", "right", "bottom")):
                bbox = {
                    "x": float(item["left"]),
                    "y": float(item["top"]),
                    "width": float(item["right"]) - float(item["left"]),
                    "height": float(item["bottom"]) - float(item["top"])
                }

            if bbox:
                entry.update(bbox)
            results.append(entry)
    return results


# === AI 偵測回調 ===
def on_detect(detections):
    """AI 偵測到物體時的回調"""
    content = list(detections.keys())
    print(f"[AI] on_detect called with: {content}", flush=True)
    if not content:
        print("[AI] Empty detections, skipping", flush=True)
        return

    # 提取邊界框資料並推送給前端
    detection_results = extract_detection_bboxes(detections)
    try:
        ui.send_message("ai_result", {
            "objects": content,
            "detections": detection_results
        })
        print(f"[AI] ai_result sent with {len(detection_results)} bbox entries", flush=True)
    except Exception as e:
        print(f"[AI] Failed to send ai_result: {e}", flush=True)

    # 檢查是否有垃圾類別
    detected_type = None
    detected_confidence = None
    for obj in content:
        obj_lower = obj.lower()
        print(f"[AI] Checking object: '{obj}' (lower: '{obj_lower}')", flush=True)
        # 優先檢查塑膠類
        for kw in PLASTIC_KEYWORDS:
            if kw in obj_lower:
                detected_type = "plastic"
                raw_conf = detections.get(obj)
                # VideoObjectDetection 回傳的 confidence 可能是 list of dicts，提取第一個 confidence 數值
                if isinstance(raw_conf, list) and len(raw_conf) > 0:
                    detected_confidence = raw_conf[0].get('confidence') if isinstance(raw_conf[0], dict) else raw_conf[0]
                elif isinstance(raw_conf, dict):
                    detected_confidence = raw_conf.get('confidence')
                else:
                    detected_confidence = raw_conf
                print(f"[AI] Matched PLASTIC keyword '{kw}' in '{obj_lower}', confidence={detected_confidence}", flush=True)
                break
        if detected_type:
            break
        # 再檢查紙杯類
        for kw in PAPER_KEYWORDS:
            if kw in obj_lower:
                detected_type = "paper"
                raw_conf = detections.get(obj)
                if isinstance(raw_conf, list) and len(raw_conf) > 0:
                    detected_confidence = raw_conf[0].get('confidence') if isinstance(raw_conf[0], dict) else raw_conf[0]
                elif isinstance(raw_conf, dict):
                    detected_confidence = raw_conf.get('confidence')
                else:
                    detected_confidence = raw_conf
                print(f"[AI] Matched PAPER keyword '{kw}' in '{obj_lower}', confidence={detected_confidence}", flush=True)
                break
        if detected_type:
            break

    if detected_type:
        print(f"[AI] Calling do_sort('{detected_type}', confidence={detected_confidence})", flush=True)
        do_sort(detected_type, detected_confidence)
    else:
        print(f"[AI] No match found in objects: {content}", flush=True)

detection.on_detect_all(on_detect)


# === 前端手動測試按鈕 ===
def on_test_sort(sid, trash_type):
    """手動測試分類（前端按鈕觸發）"""
    if trash_type in ("plastic", "paper"):
        print(f"🧪 Manual test: {trash_type}", flush=True)
        do_sort(trash_type, confidence=None)

ui.on_message("test_sort", on_test_sort)


# === 前端重置統計 ===
def on_reset_stats(sid, data):
    """清除統計數據"""
    global plastic_count, paper_count
    db.delete_all()
    plastic_count = 0
    paper_count = 0
    Bridge.call("reset_platform", 1)
    push_stats()
    print("🔄 Statistics RESET", flush=True)

ui.on_message("reset_stats", on_reset_stats)


# === 前端請求同步統計 ===
def on_request_stats(sid, data):
    """前端連線後請求同步當前統計"""
    push_stats()

ui.on_message("request_stats", on_request_stats)


# === 前端資料庫查詢 ===
def on_query_records(sid, data):
    """查詢回收記錄（分頁）"""
    try:
        page = data.get("page", 1)
        per_page = data.get("per_page", 10)
        type_filter = data.get("type_filter")
        date_from = data.get("date_from")
        date_to = data.get("date_to")

        records = db.get_records(
            page=page, per_page=per_page,
            type_filter=type_filter, date_from=date_from, date_to=date_to
        )
        counts = db.get_record_count(
            type_filter=type_filter, date_from=date_from, date_to=date_to
        )
        ui.send_message("db_query_result", {
            "_query_type": "records",
            "records": records,
            "total": counts["total"],
            "page": page
        })
    except DBStorageSQLStoreError as e:
        ui.send_message("db_query_result", {"_query_type": "records", "error": str(e)})


def on_query_stats(sid, data):
    """查詢回收統計計數"""
    try:
        type_filter = data.get("type_filter")
        date_from = data.get("date_from")
        date_to = data.get("date_to")
        counts = db.get_record_count(
            type_filter=type_filter, date_from=date_from, date_to=date_to
        )
        ui.send_message("db_query_result", {
            "_query_type": "stats",
            "plastic": counts["plastic"],
            "paper": counts["paper"],
            "total": counts["total"]
        })
    except DBStorageSQLStoreError as e:
        ui.send_message("db_query_result", {"_query_type": "stats", "error": str(e)})


def on_query_daily_counts(sid, data):
    """查詢每日回收計數"""
    try:
        date_from = data.get("date_from")
        date_to = data.get("date_to")
        result = db.get_daily_counts(date_from=date_from, date_to=date_to)
        ui.send_message("db_query_result", {"_query_type": "daily_counts", "data": result})
    except DBStorageSQLStoreError as e:
        ui.send_message("db_query_result", {"_query_type": "daily_counts", "error": str(e)})


def on_query_hourly_distribution(sid, data):
    """查詢每小時回收分佈"""
    try:
        date = data.get("date")
        result = db.get_hourly_distribution(date=date)
        ui.send_message("db_query_result", {"_query_type": "hourly_distribution", "data": result})
    except DBStorageSQLStoreError as e:
        ui.send_message("db_query_result", {"_query_type": "hourly_distribution", "error": str(e)})


ui.on_message("db_query_records", on_query_records)
ui.on_message("db_query_stats", on_query_stats)
ui.on_message("db_query_daily_counts", on_query_daily_counts)
ui.on_message("db_query_hourly_distribution", on_query_hourly_distribution)


def on_query_daily_counts_for_heatmap(sid, data):
    """查詢最近 30 天每日回收計數（供熱力圖使用）"""
    try:
        thirty_days_ago = int(time.time()) - 30 * 86400
        result = db.get_daily_counts(date_from=thirty_days_ago)
        ui.send_message("db_query_result", {"_query_type": "heatmap", "data": result})
    except DBStorageSQLStoreError as e:
        ui.send_message("db_query_result", {"_query_type": "heatmap", "error": str(e)})


ui.on_message("db_query_heatmap", on_query_daily_counts_for_heatmap)


# === 資料庫啟動 ===
db.start()

# === 從資料庫初始化計數 ===
counts = db.get_record_count()
plastic_count = counts["plastic"]
paper_count = counts["paper"]

print("🗑️  Smart Recycling Trash Bin Ready", flush=True)
print(f"   Cooldown: {COOLDOWN_SECONDS}s | Plastic keywords: {PLASTIC_KEYWORDS}", flush=True)
print(f"   Paper keywords: {PAPER_KEYWORDS}", flush=True)

# === 清理與執行 ===
import signal
import sys

def cleanup(signum=None, frame=None):
    """關閉資料庫後結束程式"""
    print("\n🛑 Shutting down...", flush=True)
    db.stop()
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

App.run()
