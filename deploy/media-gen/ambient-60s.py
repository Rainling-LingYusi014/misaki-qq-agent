#!/usr/bin/env python3
"""生成 60 秒氛围音轨（纯合成，无版权风险）：低音铺底 + 五声音阶琶音 + 简单包络。
输出 44.1kHz/16bit 立体声 WAV。"""
import math
import random
import struct
import wave

SR = 44100
DUR = 60.0
N = int(SR * DUR)
random.seed(20261027)

# 五声音阶（A 小调五声）：A C D E G
SCALE = [220.00, 261.63, 293.66, 329.63, 392.00]
BASS = [110.00, 98.00, 87.31, 110.00]  # A2 G2 F2 A2，每 15 秒换一次

buf = [0.0] * N

# 低音铺底：每 15s 一个根音，正弦 + 轻微失谐
for seg in range(4):
    f0 = BASS[seg]
    start = int(seg * 15 * SR)
    end = min(N, int((seg + 1) * 15 * SR))
    for i in range(start, end):
        t = (i - start) / SR
        env = min(1.0, t / 2.0) * min(1.0, max(0.0, ((end - start) / SR - t) / 2.0 + 0.35))
        v = 0.18 * math.sin(2 * math.pi * f0 * t) + 0.07 * math.sin(2 * math.pi * f0 * 1.005 * t)
        buf[i] += v * env

# 琶音：每 0.375s 一个音，随机走音阶（上行倾向），带指数衰减
step = 0.375
n_steps = int(DUR / step)
idx = 2
for s in range(n_steps):
    if random.random() < 0.62:
        idx = min(len(SCALE) - 1, idx + 1)
    else:
        idx = max(0, idx - random.choice([0, 1, 2]))
    f = SCALE[idx] * (2 if random.random() < 0.18 else 1)
    start = int(s * step * SR)
    length = int(0.9 * SR)
    amp = 0.11 * (0.75 + 0.25 * math.sin(s * 0.7))
    for i in range(length):
        p = start + i
        if p >= N:
            break
        t = i / SR
        env = math.exp(-3.1 * t) * min(1.0, t / 0.008)
        buf[p] += amp * env * (math.sin(2 * math.pi * f * t) + 0.22 * math.sin(4 * math.pi * f * t))

# 轻噪声垫（很轻，模拟房间感）
lp = 0.0
for i in range(N):
    lp = lp * 0.995 + random.uniform(-1, 1) * 0.005
    buf[i] += lp * 0.02 * math.sin(math.pi * i / N)

# 归一化 + 首尾淡入淡出
peak = max(1e-9, max(abs(v) for v in buf))
g = 0.85 / peak
fade = int(1.5 * SR)
out = bytearray()
for i in range(N):
    v = buf[i] * g
    if i < fade:
        v *= i / fade
    elif i > N - fade:
        v *= (N - i) / fade
    s = int(max(-1.0, min(1.0, v)) * 32767)
    out += struct.pack('<hh', s, s)

with wave.open('/tmp/m4-work/track.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(bytes(out))
print('wav ok: 60s / 44.1kHz / stereo')
