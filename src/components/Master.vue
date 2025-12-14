<template>
  <div class="master-container">
    <div class="card control-panel">
      <div class="header">
        <h2>示教臂控制台</h2>
        <div class="status-indicators">
          <span class="status-badge" :class="{ connected: signalingStatus === '已连接' }">
            <span class="status-dot"></span>
            服务器: {{ signalingStatus }}
          </span>
          <span class="status-badge" :class="{ connected: isConnected }">
            <span class="status-dot"></span>
            P2P: {{ status }}
          </span>
          <span class="status-badge" :class="{ connected: robotWsStatus === '已连接' }">
            <span class="status-dot"></span>
            机器人: {{ robotWsStatus }}
          </span>
        </div>
      </div>
      
      <div class="controls">
        <div class="input-group">
          <label>本机 ID</label>
          <input v-model="deviceId" placeholder="本机 ID" :disabled="signalingStatus === '已连接'" />
        </div>
        <div class="input-group">
          <label>目标 ID</label>
          <input v-model="targetId" placeholder="目标 ID" :disabled="signalingStatus === '已连接'" />
        </div>
        <button class="primary" @click="connectServer" :disabled="signalingStatus === '已连接'">
          {{ signalingStatus === '已连接' ? '服务器已连接' : '连接服务器' }}
        </button>
      </div>

      <div class="controls">
        <div class="input-group">
          <label>机器人串口</label>
          <select v-model="selectedDeviceId" :disabled="isRobotBusy || robotConnected">
            <option value="" disabled>请选择串口</option>
            <option v-for="d in robotDevices" :key="d.device_id + '_' + d.driver_type" :value="d.device_id">
              {{ d.device_id }}（{{ d.driver_type }}）
            </option>
          </select>
        </div>
        <div class="input-group">
          <label>驱动类型</label>
          <input :value="selectedDriverType || '-'" disabled />
        </div>
        <button @click="fetchRobotInfos" :disabled="isRobotBusy || robotConnected">
          刷新设备
        </button>
        <button class="primary" @click="connectRobot" :disabled="isRobotBusy || robotConnected || !selectedDeviceId || !selectedDriverType">
          {{ robotConnected ? '已连接' : '连接机器人' }}
        </button>
      </div>

      <div v-if="robotLastState" class="robot-state">
        <div class="robot-state-title">机器人状态（get.state）</div>
        <div class="robot-stats" v-if="txStats.frames > 0">
          <div class="robot-stats-title">实时统计（示教臂 -> DataChannel 发送）</div>
          <div class="robot-stats-grid">
            <div class="robot-stats-item"><span>FPS</span><b>{{ txStats.fps.toFixed(1) }}</b></div>
            <div class="robot-stats-item"><span>Δt P50</span><b>{{ txStats.dtP50Ms.toFixed(1) }} ms</b></div>
            <div class="robot-stats-item"><span>Δt P95</span><b>{{ txStats.dtP95Ms.toFixed(1) }} ms</b></div>
            <div class="robot-stats-item"><span>Δt P99</span><b>{{ txStats.dtP99Ms.toFixed(1) }} ms</b></div>
            <div class="robot-stats-item"><span>已发送帧</span><b>{{ txStats.frames }}</b></div>
            <div class="robot-stats-item"><span>总发送量</span><b>{{ formatBytes(txStats.totalBytes) }}</b></div>
          </div>
        </div>
        <pre class="robot-state-pre">{{ JSON.stringify(robotLastState, null, 2) }}</pre>
      </div>
    </div>

    <div class="video-wrapper card" :class="{ 'grid-view': remoteStreams.length > 1 }">
      <div class="video-placeholder" v-if="!isConnected && remoteStreams.length === 0">
        <p>远程视频将显示在这里</p>
      </div>
      <div v-for="stream in remoteStreams" :key="stream.id" class="video-item">
        <video :srcObject="stream" autoplay playsinline controls></video>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { WebRTCManager } from '../utils/webrtc';

const deviceId = ref('master_01');
const targetId = ref('robot_01');
const status = ref('未连接');
const signalingStatus = ref('未连接');
const isConnected = ref(false);
const remoteStreams = ref([]);

const isSignalingConnected = computed(() => signalingStatus.value === '已连接');

let webrtc = null;
let robotWs = null;
let robotStateTimer = null;
const isDataChannelOpen = ref(false);

// -------------------- 统计：示教臂 DataChannel 发送 --------------------
const _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const txTotalBytes = ref(0);
const txFrames = ref(0);
const _txFrameTimesMs = []; // performance.now()
const _txDeltaMs = []; // inter-frame Δt
const txStats = ref({
  fps: 0,
  dtP50Ms: 0,
  dtP95Ms: 0,
  dtP99Ms: 0,
  frames: 0,
  totalBytes: 0,
});

function _percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function _updateTxStats() {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // FPS: 最近 1s 内的帧数
  while (_txFrameTimesMs.length && now - _txFrameTimesMs[0] > 1000) _txFrameTimesMs.shift();
  const fps = _txFrameTimesMs.length;

  const tail = _txDeltaMs.slice(-300);
  const sorted = tail.slice().sort((a, b) => a - b);
  txStats.value = {
    fps,
    dtP50Ms: _percentile(sorted, 0.50),
    dtP95Ms: _percentile(sorted, 0.95),
    dtP99Ms: _percentile(sorted, 0.99),
    frames: txFrames.value,
    totalBytes: txTotalBytes.value,
  };
}

function _recordTxFrame(payloadStr) {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (_txFrameTimesMs.length) {
    const dt = now - _txFrameTimesMs[_txFrameTimesMs.length - 1];
    if (Number.isFinite(dt) && dt >= 0) _txDeltaMs.push(dt);
    if (_txDeltaMs.length > 1000) _txDeltaMs.splice(0, _txDeltaMs.length - 1000);
  }
  _txFrameTimesMs.push(now);
  txFrames.value += 1;

  let bytes = 0;
  if (_enc) bytes = _enc.encode(payloadStr).length;
  else bytes = (payloadStr || '').length; // fallback
  txTotalBytes.value += bytes;
  _updateTxStats();
}

const API_BASE = 'http://127.0.0.1:8000';
const WS_BASE = 'ws://127.0.0.1:8000';

const robotDevices = ref([]); // [{ device_id, driver_type, ... }]
const selectedDeviceId = ref('');
const robotWsStatus = ref('未连接');
const robotConnected = ref(false);
const robotLastState = ref(null);
const isRobotBusy = ref(false);

const selectedDriverType = computed(() => {
  const d = robotDevices.value.find(x => x.device_id === selectedDeviceId.value);
  return d?.driver_type || '';
});

onMounted(() => {
  webrtc = new WebRTCManager(deviceId.value, 'wss://rtc.sparklingrobo.com/signaling', 'TEACHING_ARM');
  
  webrtc.onSignalingOpen = () => { 
    signalingStatus.value = '已连接';
  };

  webrtc.onDataChannelOpen = () => {
    isDataChannelOpen.value = true;
    console.log('[webrtc] data channel open');
  };
  
  webrtc.onRegisterSuccess = () => {
    console.log("Device registered successfully");
    // Auto start call as per user request AFTER registration is confirmed
    if (targetId.value) {
      console.log("Registration confirmed, auto-starting call to", targetId.value);
      startCall();
    }
  };
  webrtc.onSignalingClose = () => { signalingStatus.value = '未连接'; };
  webrtc.onSignalingError = (err) => { 
    signalingStatus.value = '错误'; 
    status.value = err || '连接错误';
  };

  webrtc.onRemoteStream = (stream) => {
    console.log("Received remote stream:", stream.id);
    status.value = '已连接';
    isConnected.value = true;
    if (!remoteStreams.value.find(s => s.id === stream.id)) {
      remoteStreams.value.push(stream);
    }
  };

  // connectDriver(); // Disabled for video testing

  // 进入页面先拉一次设备列表，方便直接选择串口
  fetchRobotInfos();
});

const connectServer = () => {
  signalingStatus.value = '连接中...';
  if (webrtc) {
    webrtc.myId = deviceId.value;
  }
  webrtc.connectSignaling();
};


onUnmounted(() => {
  stopRobotStateLoop();
  if (robotWs) robotWs.close();
  isDataChannelOpen.value = false;
});

const fetchRobotInfos = async () => {
  isRobotBusy.value = true;
  try {
    const res = await fetch(`${API_BASE}/robots/infos?timeout=3.0`, { method: 'GET' });
    if (!res.ok) throw new Error(`infos 请求失败: ${res.status}`);
    const data = await res.json();

    // 兼容两种可能结构：
    // 1) router 返回 {"devices": {"devices": [...], "count": n}}
    // 2) 直接返回 {"devices": [...], "count": n}
    const wrapper = data?.devices ?? data;
    const list = wrapper?.devices ?? [];

    robotDevices.value = Array.isArray(list) ? list : [];
    if (!selectedDeviceId.value && robotDevices.value.length > 0) {
      selectedDeviceId.value = robotDevices.value[0].device_id;
    }
  } catch (e) {
    console.error(e);
    robotDevices.value = [];
    selectedDeviceId.value = '';
  } finally {
    isRobotBusy.value = false;
  }
};

const connectRobot = async () => {
  if (!selectedDeviceId.value || !selectedDriverType.value) return;
  isRobotBusy.value = true;
  robotWsStatus.value = '连接中...';
  try {
    const res = await fetch(`${API_BASE}/robots/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arm_type: selectedDriverType.value,
        device_id: selectedDeviceId.value,
      })
    });
    if (!res.ok) throw new Error(`connect 请求失败: ${res.status}`);
    await res.json();

    robotConnected.value = true;
    await connectRobotWsAndStartStateLoop(selectedDeviceId.value);
  } catch (e) {
    console.error(e);
    robotConnected.value = false;
    robotWsStatus.value = '错误';
  } finally {
    isRobotBusy.value = false;
  }
};

const stopRobotStateLoop = () => {
  if (robotStateTimer) {
    clearInterval(robotStateTimer);
    robotStateTimer = null;
  }
};

const connectRobotWsAndStartStateLoop = async (devicePath) => {
  stopRobotStateLoop();
  robotLastState.value = null;

  if (robotWs) {
    try { robotWs.close(); } catch {}
    robotWs = null;
  }

  // 注意：device_id 类似 "/dev/cu.xxx"，拼接后会出现双斜杠，符合后端 {device_id:path} 的用法
  const wsUrl = `${WS_BASE}/robots/ws/${devicePath}`;
  robotWs = new WebSocket(wsUrl);

  robotWs.onopen = () => {
    // 按你的要求：先发 ping
    robotWsStatus.value = '握手中...';
    robotWs.send(JSON.stringify({ type: 'ping' }));
  };

  robotWs.onerror = (err) => {
    console.error('robot ws error', err);
    robotWsStatus.value = '错误';
  };

  robotWs.onclose = () => {
    robotWsStatus.value = '未连接';
    robotConnected.value = false;
    stopRobotStateLoop();
  };

  robotWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'hello') {
        robotWsStatus.value = '已连接';

        // 收到 hello 即认为连接成功：立刻请求一次 state，并启动循环获取
        robotWs.send(JSON.stringify({ type: 'get.state' }));
        stopRobotStateLoop();
        robotStateTimer = setInterval(() => {
          if (robotWs && robotWs.readyState === WebSocket.OPEN) {
            robotWs.send(JSON.stringify({ type: 'get.state' }));
          }
        }, Math.round(1000 / 100));
        return;
      }

      if (msg.type === 'state') {
        robotLastState.value = msg;

        // 示教臂：把读取到的关节状态通过 WebRTC DataChannel 转发给操作臂，让对方“打印并执行”
        // 这里将 state 直接封装成后端 ws.py 支持的 cmd.movej 格式
        if (webrtc && isDataChannelOpen.value && msg?.joints_deg) {
          const payload = {
            type: 'cmd.movej',
            joints_deg: msg.joints_deg,
            gripper: msg.gripper ?? 0.0,
            speed: 200.0,
            src: 'teaching_arm',
            ts: msg.ts ?? Date.now() / 1000,
          };
          const payloadStr = JSON.stringify(payload);
          webrtc.sendData(payloadStr);
          _recordTxFrame(payloadStr);
        }
        return;
      }
    } catch (e) {
      console.warn('robot ws bad message', event.data);
    }
  };
};

const startCall = async () => {
  if (!targetId.value) return;
  status.value = '呼叫中...';
  try {
    await webrtc.startCall(targetId.value);
    status.value = '呼叫中...';
    // isConnected.value = true; // Wait for actual connection
  } catch (e) {
    console.error(e);
    status.value = '错误';
  }
};
</script>

<style scoped>
.master-container {
  width: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.control-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-indicators {
  display: flex;
  gap: 8px;
}

.controls {
  display: flex;
  gap: 12px;
}

.input-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.input-group label {
  font-size: 0.8rem;
  color: #666;
  margin-left: 4px;
}

.input-group input {
  width: 100%;
}

.input-group select {
  width: 100%;
  height: 38px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 10px;
  padding: 0 12px;
  background: #fff;
}

.robot-state {
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.robot-state-title {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 8px;
}

.robot-state-pre {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.04);
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.35;
}

.robot-stats {
  margin: 10px 0 10px 0;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.02);
}

.robot-stats-title {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 8px;
}

.robot-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
}

.robot-stats-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.robot-stats-item span {
  color: #666;
  font-size: 12px;
}

.robot-stats-item b {
  font-size: 12px;
  font-weight: 700;
  color: #111;
}

.video-wrapper {
  padding: 0; /* Video takes full card */
  overflow: hidden;
  background: #000;
  aspect-ratio: 16/9;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.video-wrapper.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 4px;
}

.video-item {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.video-placeholder {
  color: rgba(255, 255, 255, 0.5);
  font-weight: 500;
}

video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
