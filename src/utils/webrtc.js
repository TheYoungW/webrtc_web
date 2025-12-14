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

    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
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

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'ice-candidate',
          data: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          },
          target: this.targetId
        });
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
      ordered: true,
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
    const answerDesc = new RTCSessionDescription({
      type: 'answer',
      sdp: msg.data.sdp
    });
    await this.pc.setRemoteDescription(answerDesc);
  }

  async handleCandidate(msg) {
    if (this.pc) {
      const candidate = new RTCIceCandidate({
        candidate: msg.data.candidate,
        sdpMid: msg.data.sdpMid,
        sdpMLineIndex: msg.data.sdpMLineIndex
      });
      await this.pc.addIceCandidate(candidate);
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
}
