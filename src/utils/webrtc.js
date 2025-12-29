export class WebRTCManager {
  constructor(myId, signalingUrl, deviceType) {
    this.myId = myId;
    this.signalingUrl = signalingUrl;
    this.deviceType = deviceType; // 'EXECUTION_ARM' | 'TEACHING_ARM'
    this.ws = null;
    this.pc = null;
    this.onRemoteStream = null;
    this.onDataChannelMessage = null;
    this.onDataChannelOpen = null;
    this.dataChannel = null;

    // Callbacks for signaling status
    this.onSignalingOpen = null;
    this.onSignalingClose = null;
    this.onSignalingError = null;
    this.onRegisterSuccess = null;

    this.messageQueue = [];
    this.isSending = false;

    // ICE 服务器配置：多服务器提高可靠性和容错性
    // STUN: 用于 NAT 穿透，获取公网 IP 和端口
    // TURN: 用于中继，当直连失败时使用（需要配置自己的 TURN 服务器）
    this.iceServers = {
      iceServers: [
        // 测试模式：仅使用 TURN 服务器，禁用所有 STUN 服务器
        // 用于验证 TURN 服务器是否能正常工作
        // TODO: 测试完成后恢复 STUN 服务器配置
        // 多个 STUN 服务器作为备用，提高容错性
        // { urls: 'stun:stun.l.google.com:19302' },
        // { urls: 'stun:stun1.l.google.com:19302' },
        // { urls: 'stun:stun2.l.google.com:19302' },
        // { urls: 'stun:stun3.l.google.com:19302' },
        // { urls: 'stun:stun4.l.google.com:19302' },
        // // 其他公共 STUN 服务器作为备用
        // { urls: 'stun:stun.stunprotocol.org:3478' },
        // TURN 服务器配置：用于跨网络/NAT 中继
        // 注意：仅使用 UDP 传输，不使用 TCP
        // 原因：机器人控制场景对延迟敏感，TCP 的重传机制会导致延迟不可预测
        // UDP 即使丢包也比 TCP 重传导致的延迟要好（延迟比丢包更致命）
        {
          urls: 'turn:8.155.162.124:3478?transport=udp',
          username: 'synria',
          credential: 'xuanya666'
        }
      ]
    };
  }

  connectSignaling() {
    this.ws = new WebSocket(this.signalingUrl);

    this.ws.onopen = () => {
      console.log(`Connected to signaling server`);
      this.sendRegisterMessage();
      if (this.onSignalingOpen) this.onSignalingOpen();
    };

    this.ws.onclose = (event) => {
      console.log("Signaling connection closed", event.code, event.reason);
      if (this.onSignalingClose) this.onSignalingClose();
    };

    this.ws.onerror = (error) => {
      console.error("Signaling error:", error);
      if (this.onSignalingError) this.onSignalingError(error);
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await this.handleSignalingMessage(msg);
    };
  }

  sendRegisterMessage() {
    const msg = {
      type: "device-register",
      from: this.myId,
      deviceType: this.deviceType,
      timestamp: Date.now()
    };
    this.sendJson(msg);
  }

  async handleSignalingMessage(msg) {
    console.log(`Received signaling message of type: ${msg.type}`, msg);

    if (msg.type === 'offer') {
      await this.handleOffer(msg);
    } else if (msg.type === 'answer') {
      await this.handleAnswer(msg);
    } else if (msg.type === 'ice-candidate') {
      await this.handleCandidate(msg);
    } else if (msg.type === 'error') {
      console.error("Server error:", msg.data);
      if (this.onSignalingError) this.onSignalingError(msg.data);
    } else if (msg.type === 'success') {
      console.log("Registration successful:", msg.data);
      if (this.onRegisterSuccess) this.onRegisterSuccess(msg.data);
    }
  }

  createPeerConnection() {
    this.pc = new RTCPeerConnection(this.iceServers);

    // 监控 ICE 候选收集状态
    this.pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state: ${this.pc.iceGatheringState}`);
    };

    // 监控 ICE 连接状态变化（关键：监控直连失败和切换到 TURN）
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log(`ICE connection state changed: ${state}`);
      
      // 记录连接类型（直连 vs TURN 中继）
      this.logCurrentConnectionType();
      
      // 根据状态触发回调
      if (state === 'connected' || state === 'completed') {
        console.log("✅ WebRTC connection established");
      } else if (state === 'failed' || state === 'disconnected') {
        console.warn(`⚠️ WebRTC connection ${state}`);
        // 注意：浏览器会自动重试，包括切换到 TURN
      } else if (state === 'checking') {
        console.log("🔄 ICE checking in progress...");
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        // 记录候选类型，便于调试
        const candidateType = event.candidate.type || 'unknown';
        const candidateStr = event.candidate.candidate || '';
        
        // 判断是否为 TURN relay 候选
        const isRelay = candidateType === 'relay' || candidateStr.includes('relay');
        const prefix = isRelay ? '🔄 [TURN]' : '📡 [直连]';
        
        console.log(`${prefix} ICE candidate gathered: ${candidateType}`, candidateStr.substring(0, 100));
        
        this.sendSignalingMessage({
          type: 'ice-candidate',
          data: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          },
          target: this.targetId
        });
      } else {
        // candidate 为 null 表示 ICE gathering 完成
        console.log("✅ ICE candidate gathering completed");
        this.logCurrentConnectionType();
      }
    };

    this.pc.ontrack = (event) => {
      console.log("Received remote track");
      if (this.onRemoteStream) {
        this.onRemoteStream(event.streams[0]);
      }
    };

    this.pc.ondatachannel = (event) => {
      console.log("Received DataChannel");
      this.setupDataChannel(event.channel);
    };
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      console.log("DataChannel open");
      if (this.onDataChannelOpen) this.onDataChannelOpen();
    };
    this.dataChannel.onmessage = (event) => {
      if (this.onDataChannelMessage) {
        this.onDataChannelMessage(event.data);
      }
    };
  }

  // Called by Master
  async startCall(targetId) {
    this.targetId = targetId;
    this.createPeerConnection();

    // Ensure we ask for video even if we don't send any
    // Support up to 3 cameras
    for (let i = 0; i < 3; i++) {
      this.pc.addTransceiver('video', { direction: 'recvonly' });
    }

    // Control-first: datachannel 使用高优先级 + 有序不可靠（按顺序到达，但允许丢包不重传）
    const dc = this.pc.createDataChannel("control", {
      // ordered 默认就是 true，这里显式写上更清晰
      ordered: false,
      // 允许丢包：不重传（可能会牺牲部分消息，但不会为重传付出额外时延）
      maxRetransmits: 0,
      // 说明：不同浏览器支持程度不同；Chrome 通常支持 priority
      priority: "high",
    });
    this.setupDataChannel(dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.sendSignalingMessage({
      type: 'offer',
      data: {
        type: 'offer',
        sdp: offer.sdp
      },
      target: targetId
    });
  }

  // Called by Slave
  async handleOffer(msg) {
    this.targetId = msg.from;
    this.createPeerConnection();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });
    }

    // The 'data' field contains the actual offer SDP
    const offerDesc = new RTCSessionDescription({
      type: 'offer',
      sdp: msg.data.sdp
    });

    await this.pc.setRemoteDescription(offerDesc);

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.sendSignalingMessage({
      type: 'answer',
      data: {
        type: 'answer',
        sdp: answer.sdp
      },
      target: this.targetId
    });
  }

  async handleAnswer(msg) {
    if (!this.pc) {
      console.warn("PeerConnection not initialized, ignoring answer");
      return;
    }
    
    // 检查状态：只有在 have-local-offer 状态下才能设置 answer
    // 防止重复处理或状态错误导致的异常
    if (this.pc.signalingState !== "have-local-offer") {
      console.warn(`Skip answer: unexpected signaling state ${this.pc.signalingState}`);
      return;
    }

    try {
      const answerDesc = new RTCSessionDescription({
        type: 'answer',
        sdp: msg.data.sdp
      });
      await this.pc.setRemoteDescription(answerDesc);
      console.log("Successfully set remote answer");
    } catch (error) {
      console.error("Failed to set remote answer:", error);
      // 不抛出异常，避免影响其他消息处理
    }
  }

  async handleCandidate(msg) {
    if (!this.pc) {
      console.warn("PeerConnection not initialized, ignoring ICE candidate");
      return;
    }

    // 如果还没有设置 remote description，先缓存 candidate
    // 注意：现代浏览器通常会自动处理这种情况，但显式检查更安全
    if (this.pc.remoteDescription === null) {
      console.warn("Remote description not set yet, candidate may be queued by browser");
    }

    try {
      const candidate = new RTCIceCandidate({
        candidate: msg.data.candidate,
        sdpMid: msg.data.sdpMid,
        sdpMLineIndex: msg.data.sdpMLineIndex
      });
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add ICE candidate:", error);
      // 不抛出异常，避免影响其他消息处理
    }
  }

  sendSignalingMessage({ type, data, target }) {
    const msg = {
      type: type,
      from: this.myId,
      to: target,
      connectionType: "VIDEO", // Defaulting to VIDEO as per requirement implies shared connection
      data: data,
      timestamp: Date.now()
    };
    this.sendJson(msg);
  }

  sendJson(msg) {
    this.messageQueue.push(msg);
    this.processMessageQueue();
  }

  async processMessageQueue() {
    if (this.isSending || this.messageQueue.length === 0) return;

    this.isSending = true;
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log(`Sending signaling message of type: ${msg.type}`, msg);
        this.ws.send(JSON.stringify(msg));
        // Small delay to prevent flooding
        await new Promise(resolve => setTimeout(resolve, 50));
      } else {
        console.warn("WebSocket not open, dropping message:", msg);
      }
    }
    this.isSending = false;
  }

  sendData(data) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(data);
    }
  }

  setLocalStream(stream) {
    this.localStream = stream;
  }

  // 记录当前连接类型（直连 vs TURN 中继）
  async logCurrentConnectionType() {
    if (!this.pc) return;
    
    try {
      const stats = await this.pc.getStats();
      let hasRelay = false;
      let hasHost = false;
      let hasSrflx = false;
      
      stats.forEach((report) => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          const candidateType = report.candidateType;
          if (candidateType === 'relay') {
            hasRelay = true;
          } else if (candidateType === 'host') {
            hasHost = true;
          } else if (candidateType === 'srflx') {
            hasSrflx = true;
          }
        }
        
        // 检查选中的候选对
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localCandidate = stats.get(report.localCandidateId);
          const remoteCandidate = stats.get(report.remoteCandidateId);
          
          if (localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay') {
            hasRelay = true;
            console.log("🔄 当前使用 TURN 中继连接（内网穿透失败，已切换到中继）");
          } else if (localCandidate?.candidateType === 'srflx' || remoteCandidate?.candidateType === 'srflx') {
            hasSrflx = true;
            console.log("📡 当前使用 STUN 直连（NAT 穿透成功）");
          } else if (localCandidate?.candidateType === 'host' || remoteCandidate?.candidateType === 'host') {
            hasHost = true;
            console.log("🏠 当前使用本地直连（同一网络）");
          }
        }
      });
      
      // 汇总信息
      const connectionTypes = [];
      if (hasHost) connectionTypes.push('本地直连');
      if (hasSrflx) connectionTypes.push('STUN穿透');
      if (hasRelay) connectionTypes.push('TURN中继');
      
      if (connectionTypes.length > 0) {
        console.log(`📊 连接类型: ${connectionTypes.join(' + ')}`);
      }
    } catch (error) {
      console.warn("Failed to get connection stats:", error);
    }
  }
}
