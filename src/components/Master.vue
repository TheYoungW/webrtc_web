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
          <span class="status-badge" :class="{ connected: driverStatus.includes('Connected') }">
            <span class="status-dot"></span>
            驱动
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
const driverStatus = ref('未连接');
const isConnected = ref(false);
const remoteStreams = ref([]);

const isSignalingConnected = computed(() => signalingStatus.value === '已连接');

let webrtc = null;
let driverWs = null;

onMounted(() => {
  webrtc = new WebRTCManager(deviceId.value, 'wss://rtc.sparklingrobo.com/signaling', 'TEACHING_ARM');
  
  webrtc.onSignalingOpen = () => { 
    signalingStatus.value = '已连接';
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
});

const connectServer = () => {
  signalingStatus.value = '连接中...';
  if (webrtc) {
    webrtc.myId = deviceId.value;
  }
  webrtc.connectSignaling();
};


onUnmounted(() => {
  if (driverWs) driverWs.close();
});

const connectDriver = () => {
  driverWs = new WebSocket('ws://localhost:8002');
  
  driverWs.onopen = () => {
    driverStatus.value = '已连接';
  };

  driverWs.onclose = () => {
    driverStatus.value = '未连接';
    setTimeout(connectDriver, 2000);
  };

  driverWs.onmessage = (event) => {
    if (webrtc) {
      webrtc.sendData(event.data);
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
