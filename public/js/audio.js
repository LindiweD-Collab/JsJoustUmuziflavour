const JoustAudio = (() => {
  let actx = null
  let master = null
  let noiseBuffer = null
  let padOsc = null
  let padFilter = null
  let padGain = null
  let stepCount = 0
  const BASS_NOTES = [55, 55, 65.41, 55, 73.42, 55, 82.41, 65.41]
  const PAD_NOTES = [55, 61.74, 73.42, 82.41, 98]
  const MASTER_GAIN = 1

  const ensure = () => {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)()
      master = actx.createGain()
      master.gain.value = MASTER_GAIN
      const comp = actx.createDynamicsCompressor()
      comp.threshold.value = -8
      comp.knee.value = 8
      comp.ratio.value = 2.5
      master.connect(comp).connect(actx.destination)
    }
    if (actx.state === "suspended") actx.resume()
  }

  const getNoiseBuffer = () => {
    if (noiseBuffer) return noiseBuffer
    const length = Math.floor(actx.sampleRate * 0.4)
    noiseBuffer = actx.createBuffer(1, length, actx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    return noiseBuffer
  }

  const startPad = () => {
    if (padOsc || !actx) return
    padOsc = actx.createOscillator()
    padOsc.type = "sawtooth"
    padOsc.frequency.value = PAD_NOTES[0]
    padFilter = actx.createBiquadFilter()
    padFilter.type = "lowpass"
    padFilter.frequency.value = 380
    padFilter.Q.value = 6
    padGain = actx.createGain()
    padGain.gain.value = 0.14
    padOsc.connect(padFilter).connect(padGain).connect(master)
    padOsc.start()
  }

  const updatePad = (stageIdx, freezeActive) => {
    if (!padOsc) startPad()
    if (!padOsc) return
    const t = actx.currentTime
    padOsc.frequency.linearRampToValueAtTime(PAD_NOTES[stageIdx] || 98, t + 0.18)
    padFilter.frequency.linearRampToValueAtTime(380 + stageIdx * 420, t + 0.18)
    padGain.gain.cancelScheduledValues(t)
    padGain.gain.linearRampToValueAtTime(
      freezeActive ? 0.001 : 0.14 + stageIdx * 0.02,
      t + 0.06,
    )
  }

  const stopPad = () => {
    if (!padOsc) return
    try {
      padOsc.stop()
    } catch (err) {}
    padOsc = null
    padFilter = null
    padGain = null
  }

  const playKick = (gain = 0.9) => {
    const t = actx.currentTime
    const osc = actx.createOscillator()
    const g = actx.createGain()
    osc.type = "sine"
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.14)
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
    osc.connect(g).connect(master)
    osc.start(t)
    osc.stop(t + 0.24)
  }

  const playHat = (gain = 0.05) => {
    const t = actx.currentTime
    const src = actx.createBufferSource()
    src.buffer = getNoiseBuffer()
    const hp = actx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 7000
    const g = actx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    src.connect(hp).connect(g).connect(master)
    src.start(t)
    src.stop(t + 0.06)
  }

  const playClap = () => {
    const t = actx.currentTime
    const src = actx.createBufferSource()
    src.buffer = getNoiseBuffer()
    const bp = actx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.value = 1400
    const g = actx.createGain()
    g.gain.setValueAtTime(0.18, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
    src.connect(bp).connect(g).connect(master)
    src.start(t)
    src.stop(t + 0.18)
  }

  const playBass = (stageIdx, step) => {
    const t = actx.currentTime
    const osc = actx.createOscillator()
    const filter = actx.createBiquadFilter()
    const g = actx.createGain()
    osc.type = "square"
    osc.frequency.value = BASS_NOTES[step % BASS_NOTES.length]
    filter.type = "lowpass"
    filter.frequency.value = 220 + stageIdx * 160
    g.gain.setValueAtTime(0.2, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    osc.connect(filter).connect(g).connect(master)
    osc.start(t)
    osc.stop(t + 0.22)
  }

  const playCountdown = () => {
    [0, 1, 2].forEach((i) => {
      const t = actx.currentTime + i
      const osc = actx.createOscillator()
      const g = actx.createGain()
      osc.type = "triangle"
      osc.frequency.value = i === 2 ? 880 : 523.25
      g.gain.setValueAtTime(0.001, t)
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32)
      osc.connect(g).connect(master)
      osc.start(t)
      osc.stop(t + 0.34)
    })
  }

  const playFreezeSting = () => {
    const t = actx.currentTime
    if (master) {
      master.gain.cancelScheduledValues(t)
      master.gain.setValueAtTime(master.gain.value, t)
      master.gain.linearRampToValueAtTime(0.22, t + 0.04)
    }
    const src = actx.createBufferSource()
    src.buffer = getNoiseBuffer()
    const bp = actx.createBiquadFilter()
    bp.type = "bandpass"
    bp.Q.value = 4
    bp.frequency.setValueAtTime(1200, t)
    bp.frequency.exponentialRampToValueAtTime(180, t + 0.55)
    const ng = actx.createGain()
    ng.gain.setValueAtTime(0.28, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.7)
    src.connect(bp).connect(ng).connect(actx.destination)
    src.start(t)
    src.stop(t + 0.7)
    ;[196, 207.65, 311.13, 466.16].forEach((freq) => {
      const osc = actx.createOscillator()
      const g = actx.createGain()
      osc.type = "sawtooth"
      osc.frequency.setValueAtTime(freq, t)
      osc.frequency.exponentialRampToValueAtTime(freq * 0.45, t + 0.85)
      g.gain.setValueAtTime(0.09, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
      osc.connect(g).connect(actx.destination)
      osc.start(t)
      osc.stop(t + 0.92)
    })
  }

  const releaseFreeze = () => {
    if (!master) return
    const t = actx.currentTime
    master.gain.cancelScheduledValues(t)
    master.gain.linearRampToValueAtTime(MASTER_GAIN, t + 0.12)
  }

  const playStep = (stageIdx) => {
    const downbeat = stepCount % 2 === 0
    if (downbeat) {
      playKick(stepCount % 8 === 0 ? 1 : 0.82)
      playBass(stageIdx, Math.floor(stepCount / 2))
    }
    playHat(downbeat ? 0.08 : 0.06 + stageIdx * 0.012)
    if (stageIdx >= 2 && stepCount % 4 === 2) playClap()
    if (stageIdx >= 4 && !downbeat) playHat(0.12)
    stepCount += 1
  }

  const playClashSting = () => {
    if (!actx) return
    const t = actx.currentTime
    ;[330, 392].forEach((freq, i) => {
      const osc = actx.createOscillator()
      const g = actx.createGain()
      osc.type = "square"
      osc.frequency.value = freq
      g.gain.setValueAtTime(0.12, t + i * 0.04)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
      osc.connect(g).connect(master)
      osc.start(t)
      osc.stop(t + 0.2)
    })
  }

  const playVictoryFanfare = () => {
    ensure()
    ;[523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const t = actx.currentTime + i * 0.13
      const osc = actx.createOscillator()
      const g = actx.createGain()
      osc.type = "triangle"
      osc.frequency.value = freq
      g.gain.setValueAtTime(0.001, t)
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
      osc.connect(g).connect(master)
      osc.start(t)
      osc.stop(t + 0.48)
    })
  }

  const resetGroove = () => {
    stopPad()
    stepCount = 0
    if (master && actx) {
      master.gain.cancelScheduledValues(actx.currentTime)
      master.gain.value = MASTER_GAIN
    }
  }

  return {
    ensure,
    updatePad,
    stopPad,
    playCountdown,
    playFreezeSting,
    releaseFreeze,
    playStep,
    playClashSting,
    playVictoryFanfare,
    resetGroove,
    isReady: () => !!actx,
  }
})()
