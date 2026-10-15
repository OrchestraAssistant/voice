/**
 * The WebRTC half of a realtime session: a peer connection, an audio element,
 * a microphone, and a data channel.
 *
 * Separated from the protocol so the protocol can be tested. Everything
 * interesting in a session -- when to ask for a response, what medium to ask
 * for, when a turn is over, when to hang up -- used to live inside a closure
 * over a live connection, so the only way to check any of it was to assert
 * that the source code READ a certain way. Thirty-four tests did exactly that,
 * and they broke on refactors that changed nothing while passing on behaviour
 * that was wrong.
 *
 * The protocol now talks to an object with `send` and `addEventListener`, and
 * a test can supply one.
 */
export function webrtcTransport({ initialMode = "continuous" } = {}) {
  const pc = new RTCPeerConnection();

  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (event) => {
    audioEl.srcObject = event.streams[0];
  };

  // The audio sender is negotiated NOW, with or without a track in it, so a
  // microphone attached later needs only replaceTrack() -- which does not
  // renegotiate. addTrack() after the fact would need a second offer/answer,
  // and it is not clear this endpoint accepts one.
  const sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
  let micTrack = null;

  const channel = pc.createDataChannel("oai-events");

  return {
    channel,

    async attachMic() {
      if (micTrack) return micTrack;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micTrack = stream.getAudioTracks()[0];
      micTrack.enabled = initialMode !== "ptt"; // ptt rests muted; the others rest live
      await sender.replaceTrack(micTrack);
      return micTrack;
    },

    async releaseMic() {
      if (!micTrack) return false;
      micTrack.stop();
      // Order matters: null the field first, so an attachMic() racing this does
      // not hand back a track that is already stopped.
      micTrack = null;
      await sender.replaceTrack(null);
      return true;
    },

    hasMic: () => !!micTrack,
    setMicEnabled(enabled) {
      if (micTrack) micTrack.enabled = enabled;
    },

    /** The SDP exchange. Everything above works offline; this is the part that
     *  needs the network and the key. */
    async connect(ephemeralKey) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`Realtime SDP exchange failed: ${res.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    },

    close() {
      channel.close();
      micTrack = null;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
    },
  };
}
