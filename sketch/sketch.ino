/*
 * 智慧垃圾分類回收桶 - Arduino 韌體
 * Smart Recycling Trash Bin - Arduino Firmware
 * 
 * 硬體配置：
 *   - 舵機: MG996R (手動 PWM 脈衝控制，不需 Servo.h)
 *   - 訊號線: D11 (PWM 腳位)
 *   - 電源: MG996R 紅線接外部 5V~6V 電源，棕線接 GND
 *   - 預設角度 90° = 平台水平穩定
 *   - 塑膠模式 → 30° (向左傾倒)
 *   - 紙杯模式 → 150° (向右傾倒)
 *   - 傾倒後自動回正至 90°
 * 
 * PWM 原理：
 *   標準舵機需要 50Hz (20ms 週期) 的 PWM 訊號
 *   脈衝寬度 500µs = 0°, 1500µs = 90°, 2500µs = 180°
 *   每次 loop() 發送一個脈衝，delayMicroseconds 最多阻塞 2.5ms，
 *   不影響 Bridge.update() 正常運作
 */

// SPDX-FileCopyrightText: Copyright (C) ARDUINO SRL (http://www.arduino.cc)
// SPDX-License-Identifier: MPL-2.0

#include <MsgPack.h>
#include <Arduino_RPClite.h> 
#include "Arduino_RouterBridge.h"

// ============================================================
// === 硬體配置 ===
// ============================================================
// MG996R 接線：
//   橘色 (訊號) → D11
//   紅色 (電源) → 外部 5V~6V 電源正極 (不要用板上 5V，電流不夠)
//   棕色 (GND)  → GND (Arduino GND 與外部電源 GND 要共地)
// ============================================================
const int SERVO_PIN = D11;

// === 舵機角度常數 ===
const int ANGLE_NEUTRAL = 90;   // 水平穩定 (待機)
const int ANGLE_PLASTIC = 30;   // 塑膠方向 (左傾)
const int ANGLE_PAPER   = 150;  // 紙杯方向 (右傾)

// === 手動 PWM 控制變數 ===
int currentAngle = 90;                // 目前目標角度
unsigned long lastPulseTime = 0;      // 上次脈衝時間 (micros)
const unsigned long PULSE_PERIOD = 20000;  // 20ms = 50Hz

// === 分流狀態機 ===
enum SortState {
    STATE_IDLE,       // 待機 (90° 水平)
    STATE_TILTING,    // 正在傾倒
    STATE_RETURNING   // 回正中
};

volatile SortState currentState = STATE_IDLE;
unsigned long tiltStartTime = 0;
const unsigned long TILT_HOLD_MS = 1500;     // 傾倒維持 1.5 秒，加快回正節奏
const unsigned long RETURN_TIME_MS = 500;    // 回正等待時間 (ms)

// === 冷卻時間防重複 ===
// Bridge RPC 底層可能有超時重試，導致同一條 sort 指令被送達兩次。
// 此計時器獨立於狀態機，確保無論狀態為何，5 秒內不接受新的 sort 命令。
unsigned long lastSortTime = 0;
const unsigned long SORT_COOLDOWN_MS = 5000; // 5 秒冷卻（大於任何可能的 RPC 超時）
int lastSortSeq = 0; // 最後一次接受的序列號

// ============================================================
// === 手動舵機 PWM 控制函式 ===
// ============================================================

/**
 * 設定舵機目標角度 (0~180)
 */
void servoWrite(int angle) {
    currentAngle = constrain(angle, 0, 180);
}

/**
 * 在 loop() 中呼叫，定期發送 PWM 脈衝維持舵機位置
 * 每 20ms 發送一次脈衝，脈衝寬度對應角度
 * 阻塞時間最多 2.5ms，不影響 Bridge 通訊
 */
void servoRefresh() {
    unsigned long now = micros();
    if (now - lastPulseTime < PULSE_PERIOD) return;
    lastPulseTime = now;

    // 角度轉脈衝寬度: 0° → 500µs, 90° → 1500µs, 180° → 2500µs
    int pulseWidth = map(currentAngle, 0, 180, 500, 2500);

    digitalWrite(SERVO_PIN, HIGH);
    delayMicroseconds(pulseWidth);
    digitalWrite(SERVO_PIN, LOW);
}

// ============================================================

void setup() {
    Serial.begin(9600);
    
    // 初始化舵機腳位
    pinMode(SERVO_PIN, OUTPUT);
    digitalWrite(SERVO_PIN, LOW);
    delay(100);
    
    // 舵機歸位到水平位置
    servoWrite(ANGLE_NEUTRAL);

    // Bridge 註冊
    Bridge.begin();
    Bridge.provide("sort_plastic", sort_plastic);
    Bridge.provide("sort_paper", sort_paper);
    Bridge.provide("reset_platform", reset_platform);

    Serial.println("Smart Trash Bin Ready (Direct PWM Mode - D11)");
}

void loop() {
    Bridge.update();
    servoRefresh();  // 持續發送 PWM 脈衝維持舵機位置

    unsigned long now = millis();

    switch (currentState) {
        case STATE_IDLE:
            // 待機狀態，平台保持水平
            break;

        case STATE_TILTING:
            // 傾倒中 → 維持傾斜角度一段時間
            if (now - tiltStartTime >= TILT_HOLD_MS) {
                // 時間到，回正
                servoWrite(ANGLE_NEUTRAL);
                currentState = STATE_RETURNING;
                tiltStartTime = now;
            }
            break;

        case STATE_RETURNING:
            // 等待回正動作完成
            if (now - tiltStartTime >= RETURN_TIME_MS) {
                currentState = STATE_IDLE;
            }
            break;
    }
}

// === Bridge 回調 ===

// 分類塑膠：舵機轉向塑膠桶方向
void sort_plastic(int seq) {
    unsigned long now = millis();
    Serial.print(">> sort_plastic called, seq=");
    Serial.print(seq);
    Serial.print(", state=");
    Serial.print(currentState);
    Serial.print(", lastSeq=");
    Serial.print(lastSortSeq);
    Serial.print(", elapsed=");
    Serial.println(now - lastSortTime);

    if (currentState != STATE_IDLE) {
        Serial.println(">> REJECTED: not IDLE");
        return;
    }
    if (now - lastSortTime <= SORT_COOLDOWN_MS && seq <= lastSortSeq) {
        Serial.println(">> REJECTED: cooldown or duplicate seq");
        return;
    }

    lastSortTime = now;
    lastSortSeq = seq;
    servoWrite(ANGLE_PLASTIC);
    tiltStartTime = millis();
    currentState = STATE_TILTING;
    Serial.println(">> ACCEPTED: Sorting PLASTIC");
}

// 分類紙杯：舵機轉向紙杯桶方向
void sort_paper(int seq) {
    unsigned long now = millis();
    Serial.print(">> sort_paper called, seq=");
    Serial.print(seq);
    Serial.print(", state=");
    Serial.print(currentState);
    Serial.print(", lastSeq=");
    Serial.print(lastSortSeq);
    Serial.print(", elapsed=");
    Serial.println(now - lastSortTime);

    if (currentState != STATE_IDLE) {
        Serial.println(">> REJECTED: not IDLE");
        return;
    }
    if (now - lastSortTime <= SORT_COOLDOWN_MS && seq <= lastSortSeq) {
        Serial.println(">> REJECTED: cooldown or duplicate seq");
        return;
    }

    lastSortTime = now;
    lastSortSeq = seq;
    servoWrite(ANGLE_PAPER);
    tiltStartTime = millis();
    currentState = STATE_TILTING;
    Serial.println(">> ACCEPTED: Sorting PAPER CUP");
}

// 強制回正
void reset_platform(int dummy) {
    servoWrite(ANGLE_NEUTRAL);
    currentState = STATE_IDLE;
    Serial.println(">> Platform RESET to neutral");
}
