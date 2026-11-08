/*!
 *  @nkzw/audio
 *
 *  (c) 2013-2020, James Simpson of GoldFire Studios
 *  (c) 2026, Nakazawa Tech
 *
 *  MIT License
 */

import { installSpatial } from './plugins/audio.spatial.js';

const SilentMedia =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

/**
 * @param {import('./index.ts').AudioOptions} [options]
 * @returns {import('./index.ts').Audio}
 */
export function createAudio({ autoSuspend = true, html5PoolSize = 10 } = {}) {
  const lifetime = new AbortController();
  let disposePromise;

  /** Global Methods **/
  /***************************************************************************/

  /**
   * Create the global controller. All contained methods and properties apply
   * to all sounds that are currently playing or will be in the future.
   */
  const AudioController = function () {
    this.init();
  };
  AudioController.prototype = {
    /**
     * Initialize the global audio object.
     * @return {audio}
     */
    init() {
      const self = this;

      // Create a global ID counter.
      self._counter = 1000;

      // Pool of unlocked HTML5 Audio objects.
      self._html5AudioPool = [];
      self.html5PoolSize = html5PoolSize;

      // Internal properties.
      self._codecs = {};
      self._soundGroups = [];
      self._muted = false;
      self._volume = 1;
      self._canPlayEvent = 'canplaythrough';
      self._navigator = globalThis.navigator;

      // Public properties.
      self.masterGain = null;
      self.noAudio = false;
      self.usingWebAudio = true;
      self.autoSuspend = autoSuspend;
      self.ctx = null;

      // Set to false to disable the auto audio unlocker.
      self.autoUnlock = true;

      // Setup the various state values for global tracking.
      self._setup();

      return self;
    },

    /**
     * Get/set the global volume for all sounds.
     * @param  {Float} vol Volume from 0.0 to 1.0.
     * @return {audio/Float}     Returns self or current volume.
     */
    volume(vol) {
      const self = this;
      vol = Number.parseFloat(vol);

      // If we don't have an AudioContext created yet, run the setup.
      if (!self.ctx) {
        setupAudioContext();
      }

      if (vol !== undefined && vol >= 0 && vol <= 1) {
        self._volume = vol;

        // Don't update any of the nodes if we are muted.
        if (self._muted) {
          return self;
        }

        // When using Web Audio, we just need to adjust the master gain.
        if (self.usingWebAudio) {
          self.masterGain.gain.setValueAtTime(vol, audio.ctx.currentTime);
        }

        // Loop through and change volume for all HTML5 audio nodes.
        for (let i = 0; i < self._soundGroups.length; i++) {
          if (!self._soundGroups[i]._webAudio) {
            // Get all of the sounds in this Sound group.
            const ids = self._soundGroups[i]._getSoundIds();

            // Loop through all sounds and change the volumes.
            for (let j = 0; j < ids.length; j++) {
              const sound = self._soundGroups[i]._soundById(ids[j]);

              if (sound && sound._node) {
                sound._node.volume = sound._volume * vol;
              }
            }
          }
        }

        return self;
      }

      return self._volume;
    },

    /**
     * Handle muting and unmuting globally.
     * @param  {Boolean} muted Is muted or not.
     */
    mute(muted) {
      const self = this;

      // If we don't have an AudioContext created yet, run the setup.
      if (!self.ctx) {
        setupAudioContext();
      }

      self._muted = muted;

      // With Web Audio, we just need to mute the master gain.
      if (self.usingWebAudio) {
        self.masterGain.gain.setValueAtTime(muted ? 0 : self._volume, audio.ctx.currentTime);
      }

      // Loop through and mute all HTML5 Audio nodes.
      for (let i = 0; i < self._soundGroups.length; i++) {
        if (!self._soundGroups[i]._webAudio) {
          // Get all of the sounds in this Sound group.
          const ids = self._soundGroups[i]._getSoundIds();

          // Loop through all sounds and mark the audio node as muted.
          for (let j = 0; j < ids.length; j++) {
            const sound = self._soundGroups[i]._soundById(ids[j]);

            if (sound && sound._node) {
              sound._node.muted = muted ? true : sound._muted;
            }
          }
        }
      }

      return self;
    },

    /**
     * Handle stopping all sounds globally.
     */
    stop() {
      const self = this;

      // Loop through all Sounds and stop them.
      for (let i = 0; i < self._soundGroups.length; i++) {
        self._soundGroups[i].stop();
      }

      return self;
    },

    /**
     * Unload and destroy all currently loaded Sound objects.
     * @return {audio}
     */
    unload() {
      const self = this;

      for (let i = self._soundGroups.length - 1; i >= 0; i--) {
        self._soundGroups[i].unload();
      }

      // Create a new AudioContext to make sure it is fully reset.
      if (self.usingWebAudio && self.ctx && self.ctx.close !== undefined) {
        self.ctx.close();
        self.ctx = null;
        setupAudioContext();
      }

      return self;
    },

    /**
     * Check for codec support of specific extension.
     * @param  {String} ext Audio file extention.
     * @return {Boolean}
     */
    codecs(ext) {
      return this._codecs[ext.replace(/^x-/, '')];
    },

    /**
     * Setup various state values for global tracking.
     * @return {audio}
     */
    _setup() {
      const self = this;

      // Keeps track of the suspend/resume state of the AudioContext.
      self.state = self.ctx ? self.ctx.state || 'suspended' : 'suspended';

      // Automatically begin the 30-second suspend process
      self._autoSuspend();

      // Check if audio is available.
      if (!self.usingWebAudio) {
        // No audio is available on this system if noAudio is set to true.
        if (globalThis.Audio !== undefined) {
          try {
            const test = new Audio();

            // Check if the canplaythrough event is available.
            if (test.oncanplaythrough === undefined) {
              self._canPlayEvent = 'canplay';
            }
          } catch {
            self.noAudio = true;
          }
        } else {
          self.noAudio = true;
        }
      }

      // Check for supported codecs.
      if (!self.noAudio) {
        self._setupCodecs();
      }

      return self;
    },

    /**
     * Check for browser support for various codecs and cache the results.
     * @return {audio}
     */
    _setupCodecs() {
      const self = this;
      let audioTest = null;

      try {
        audioTest = globalThis.Audio === undefined ? null : new Audio();
      } catch {
        return self;
      }
      if (!audioTest) {
        return self;
      }

      const mpegTest = audioTest.canPlayType('audio/mpeg;');
      self._codecs = {
        mp3: Boolean(mpegTest || audioTest.canPlayType('audio/mp3;')),
        mpeg: !!mpegTest,
        opus: !!audioTest.canPlayType('audio/ogg; codecs="opus"'),
        ogg: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"'),
        oga: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"'),
        wav: !!(
          audioTest.canPlayType('audio/wav; codecs="1"') || audioTest.canPlayType('audio/wav')
        ),
        aac: !!audioTest.canPlayType('audio/aac;'),
        caf: !!audioTest.canPlayType('audio/x-caf;'),
        m4a: !!(
          audioTest.canPlayType('audio/x-m4a;') ||
          audioTest.canPlayType('audio/m4a;') ||
          audioTest.canPlayType('audio/aac;')
        ),
        m4b: !!(
          audioTest.canPlayType('audio/x-m4b;') ||
          audioTest.canPlayType('audio/m4b;') ||
          audioTest.canPlayType('audio/aac;')
        ),
        mp4: !!(
          audioTest.canPlayType('audio/x-mp4;') ||
          audioTest.canPlayType('audio/mp4;') ||
          audioTest.canPlayType('audio/aac;')
        ),
        weba: Boolean(audioTest.canPlayType('audio/webm; codecs="vorbis"')),
        webm: Boolean(audioTest.canPlayType('audio/webm; codecs="vorbis"')),
        dolby: !!audioTest.canPlayType('audio/mp4; codecs="ec-3"'),
        flac: !!(audioTest.canPlayType('audio/x-flac;') || audioTest.canPlayType('audio/flac;')),
      };

      return self;
    },

    /**
     * Some browsers/devices will only allow audio to be played after a user interaction.
     * Attempt to automatically unlock audio on the first user interaction.
     * Concept from: http://paulbakaus.com/tutorials/html5/web-audio-on-ios/
     * @return {audio}
     */
    _unlockAudio() {
      const self = this;

      // Only run this if Web Audio is supported and it hasn't already been unlocked.
      if (self._audioUnlocked || !self.ctx) {
        return;
      }

      self._audioUnlocked = false;
      self.autoUnlock = false;

      // Some mobile devices/platforms have distortion issues when opening/closing tabs and/or web views.
      // Bugs in the browser (especially Mobile Safari) can cause the sampleRate to change from 44100 to 48000.
      // By calling audio.unload(), we create a new AudioContext with the correct sampleRate.
      if (!self._mobileUnloaded && self.ctx.sampleRate !== 44_100) {
        self._mobileUnloaded = true;
        self.unload();
      }

      // Scratch buffer for enabling iOS to dispose of web audio buffers correctly, as per:
      // http://stackoverflow.com/questions/24119684
      self._scratchBuffer = self.ctx.createBuffer(1, 1, 22_050);

      // Call this method on touch start to create and play a buffer,
      // then check if the audio actually played to determine if
      // audio has now been unlocked on iOS, Android, etc.
      let locked = false;
      const unlock = function () {
        if (locked) {
          return;
        }

        locked = true;
        setTimeout(() => {
          locked = false;
        }, 300);

        // Create a pool of unlocked HTML5 Audio objects that can
        // be used for playing sounds without user interaction. HTML5
        // Audio objects must be individually unlocked, as opposed
        // to the WebAudio API which only needs a single activation.
        // This must occur before WebAudio setup or the source.onended
        // event will not fire.
        while (self._html5AudioPool.length < self.html5PoolSize) {
          try {
            const audioNode = new Audio();

            // Mark this Audio object as unlocked to ensure it can get returned
            // to the unlocked pool when released.
            audioNode._unlocked = true;

            // Add the audio node to the pool.
            self._releaseHtml5Audio(audioNode);
          } catch {
            self.noAudio = true;
            break;
          }
        }

        // Loop through any assigned audio nodes and unlock them.
        for (let i = 0; i < self._soundGroups.length; i++) {
          if (!self._soundGroups[i]._webAudio) {
            // Get all of the sounds in this Sound group.
            const ids = self._soundGroups[i]._getSoundIds();

            // Loop through all sounds and unlock the audio nodes.
            for (let j = 0; j < ids.length; j++) {
              const sound = self._soundGroups[i]._soundById(ids[j]);

              if (sound && sound._node && !sound._node._unlocked) {
                sound._node._unlocked = true;
                sound._node.load();
              }
            }
          }
        }

        // Fix Android can not play in suspend state.
        self._autoResume();

        // Create an empty buffer.
        const source = self.ctx.createBufferSource();
        source.buffer = self._scratchBuffer;
        source.connect(self.ctx.destination);

        // Play the empty buffer.
        source.start(0);

        // Calling resume() on a stack initiated by user gesture is what actually unlocks the audio on Android Chrome >= 55.
        self.ctx.resume().catch(() => {});

        // Setup a timeout to check that we are unlocked on the next event loop.
        source.onended = function () {
          source.disconnect(0);

          // Update the unlocked state and prevent this check from happening again.
          self._audioUnlocked = true;

          // Remove the touch start listener.
          if (lifetime.signal.aborted) {
            return;
          }
          self._removeUnlockListeners();

          // Let all sounds know that audio has been unlocked.
          for (let i = 0; i < self._soundGroups.length; i++) {
            self._soundGroups[i]._emit('unlock');
          }
        };
      };

      const events = ['touchstart', 'touchend', 'click', 'keydown'];
      for (const event of events) {
        document.addEventListener(event, unlock, true);
      }
      self._removeUnlockListeners = () => {
        for (const event of events) {
          document.removeEventListener(event, unlock, true);
        }
        self._removeUnlockListeners = null;
      };

      return self;
    },

    /**
     * Get an unlocked HTML5 Audio object from the pool. If none are left,
     * return a new Audio object and throw a warning.
     * @return {Audio} HTML5 Audio object.
     */
    _obtainHtml5Audio() {
      const self = this;

      // Return the next object from the pool if one exists.
      if (self._html5AudioPool.length) {
        return self._html5AudioPool.pop();
      }

      return new Audio();
    },

    /**
     * Return an activated HTML5 Audio object to the pool.
     * @return {audio}
     */
    _releaseHtml5Audio(audio) {
      const self = this;

      // Don't add audio to the pool if we don't know if it has been unlocked.
      if (audio._unlocked) {
        self._html5AudioPool.push(audio);
      }

      return self;
    },

    retainAudioContext() {
      const self = this;
      let released = false;
      if (lifetime.signal.aborted) {
        throw new Error('The audio instance has been disposed.');
      }
      self._externalAudio = (self._externalAudio || 0) + 1;
      self._autoResume();
      return function () {
        if (!released) {
          released = true;
          self._externalAudio--;
          self._autoSuspend();
        }
      };
    },

    /**
     * Automatically suspend the Web Audio AudioContext after no sound has played for 30 seconds.
     * This saves processing/energy and fixes various browser-specific bugs with audio getting stuck.
     * @return {audio}
     */
    _autoSuspend() {
      const self = this;

      if (
        !self.autoSuspend ||
        self._externalAudio ||
        !self.ctx ||
        self.ctx.suspend === undefined ||
        !audio.usingWebAudio
      ) {
        return;
      }

      // Check if any sounds are playing.
      for (let i = 0; i < self._soundGroups.length; i++) {
        if (self._soundGroups[i]._webAudio) {
          for (let j = 0; j < self._soundGroups[i]._sounds.length; j++) {
            if (!self._soundGroups[i]._sounds[j]._paused) {
              return self;
            }
          }
        }
      }

      if (self._suspendTimer) {
        clearTimeout(self._suspendTimer);
      }

      // If no sound has played after 30 seconds, suspend the context.
      const context = self.ctx;
      self._suspendTimer = setTimeout(() => {
        self._suspendTimer = null;
        if (self.ctx !== context || !self.autoSuspend || self._externalAudio) {
          return;
        }

        self.state = 'suspending';

        // Handle updating the state of the audio context after suspending.
        const handleSuspension = function () {
          if (self.ctx !== context) {
            return;
          }
          self.state = 'suspended';

          if (self._resumeAfterSuspend) {
            delete self._resumeAfterSuspend;
            self._autoResume();
          }
        };

        // Either the state gets suspended or it is interrupted.
        // Either way, we need to update the state to suspended.
        context.suspend().then(handleSuspension, handleSuspension);
      }, 30_000);

      return self;
    },

    /**
     * Automatically resume the Web Audio AudioContext when a new sound is played.
     * @return {audio}
     */
    _autoResume() {
      const self = this;

      if (!self.ctx || self.ctx.resume === undefined || !audio.usingWebAudio) {
        return;
      }

      if (self.state === 'running' && self.ctx.state !== 'interrupted' && self._suspendTimer) {
        clearTimeout(self._suspendTimer);
        self._suspendTimer = null;
      } else if (
        self.state === 'suspended' ||
        (self.state === 'running' && self.ctx.state === 'interrupted')
      ) {
        const context = self.ctx;
        context.resume().then(
          () => {
            if (self.ctx !== context) {
              return;
            }
            self.state = 'running';

            // Emit to all Sounds that the audio has resumed.
            for (let i = 0; i < self._soundGroups.length; i++) {
              self._soundGroups[i]._emit('resume');
            }
          },
          () => {},
        );

        if (self._suspendTimer) {
          clearTimeout(self._suspendTimer);
          self._suspendTimer = null;
        }
      } else if (self.state === 'suspending') {
        self._resumeAfterSuspend = true;
      }

      return self;
    },
  };

  // Setup the global audio controller.
  const audio = new AudioController();

  /** Group Methods **/
  /***************************************************************************/

  /**
   * Create an audio group controller.
   * @param {Object} o Passed in properties for this group.
   */
  const Sound = function (o) {
    const self = this;

    self.init(o);
  };
  Sound.prototype = {
    /**
     * Initialize a new Sound group object.
     * @param  {Object} o Passed in properties for this group.
     * @return {Sound}
     */
    init(o) {
      const self = this;

      prepareOutput();

      // Setup user-defined default properties.
      self._autoplay = o.autoplay || false;
      self._format = typeof o.format !== 'string' ? o.format : [o.format];
      self._html5 = o.html5 || false;
      self._muted = o.mute || false;
      self._loop = o.loop || false;
      self._pool = o.pool || 5;
      self._preload = typeof o.preload === 'boolean' || o.preload === 'metadata' ? o.preload : true;
      self._rate = o.rate || 1;
      self._sprite = o.sprite || {};
      self._src = typeof o.src !== 'string' ? o.src : [o.src];
      self._volume = o.volume !== undefined ? o.volume : 1;
      self._xhr = {
        method: o.xhr && o.xhr.method ? o.xhr.method : 'GET',
        headers: o.xhr && o.xhr.headers ? o.xhr.headers : null,
        withCredentials: o.xhr && o.xhr.withCredentials ? o.xhr.withCredentials : false,
      };

      // Setup all other default properties.
      self._duration = 0;
      self._disposed = false;
      self._state = 'unloaded';
      self._sounds = [];
      self._endTimers = {};
      self._queue = [];
      self._playLock = false;

      // Setup event listeners.
      self._onend = o.onend ? [{ fn: o.onend }] : [];
      self._onfade = o.onfade ? [{ fn: o.onfade }] : [];
      self._onload = o.onload ? [{ fn: o.onload }] : [];
      self._onloaderror = o.onloaderror ? [{ fn: o.onloaderror }] : [];
      self._onplayerror = o.onplayerror ? [{ fn: o.onplayerror }] : [];
      self._onpause = o.onpause ? [{ fn: o.onpause }] : [];
      self._onplay = o.onplay ? [{ fn: o.onplay }] : [];
      self._onstop = o.onstop ? [{ fn: o.onstop }] : [];
      self._onmute = o.onmute ? [{ fn: o.onmute }] : [];
      self._onvolume = o.onvolume ? [{ fn: o.onvolume }] : [];
      self._onrate = o.onrate ? [{ fn: o.onrate }] : [];
      self._onseek = o.onseek ? [{ fn: o.onseek }] : [];
      self._onunlock = o.onunlock ? [{ fn: o.onunlock }] : [];
      self._onresume = [];

      // Web Audio or HTML5 Audio?
      self._webAudio = audio.usingWebAudio && !self._html5;

      // Keep track of this Sound group in the global controller.
      audio._soundGroups.push(self);

      // If they selected autoplay, add a play event to the load queue.
      if (self._autoplay) {
        self._queue.push({
          event: 'play',
          action() {
            self.play();
          },
        });
      }

      // Load the source file unless otherwise specified.
      if (self._preload && self._preload !== 'none') {
        self.load();
      }

      return self;
    },

    /**
     * Load the audio file.
     * @return {audio}
     */
    load() {
      const self = this;
      let url = null;

      if (self._disposed || self._state !== 'unloaded') {
        return self;
      }

      // If no audio is available, quit immediately.
      if (audio.noAudio) {
        self._emit('loaderror', null, 'No audio support.');
        return;
      }

      // Make sure our source is in an array.
      if (typeof self._src === 'string') {
        self._src = [self._src];
      }

      // Loop through the sources and pick the first one that is compatible.
      for (let i = 0; i < self._src.length; i++) {
        let ext;

        if (self._format && self._format[i]) {
          // If an extension was specified, use that instead.
          ext = self._format[i];
        } else {
          // Make sure the source is a string.
          const str = self._src[i];
          if (typeof str !== 'string') {
            self._emit('loaderror', null, 'Non-string found in selected audio sources - ignoring.');
            continue;
          }

          // Extract the file extension from the URL or base64 data URI.
          ext = /^data:audio\/([^;,]+);/i.exec(str);
          if (!ext) {
            ext = /\.([^.]+)$/.exec(str.split('?', 1)[0]);
          }

          if (ext) {
            ext = ext[1].toLowerCase();
          }
        }

        // Check if this extension is available.
        if (ext && audio.codecs(ext)) {
          url = self._src[i];
          break;
        }
      }

      if (!url) {
        self._emit('loaderror', null, 'No codec support for selected audio sources.');
        return;
      }

      self._src = url;
      self._state = 'loading';

      // If the hosting page is HTTPS and the source isn't,
      // drop down to HTML5 Audio to avoid Mixed Content errors.
      if (window.location.protocol === 'https:' && url.slice(0, 5) === 'http:') {
        self._html5 = true;
        self._webAudio = false;
      }

      if (self._sounds.length === 0) {
        new SoundInstance(self);
      }

      // Load and decode the audio data for playback.
      if (self._webAudio) {
        loadBuffer(self);
      }

      return self;
    },

    /**
     * Play a sound or resume previous playback.
     * @param  {String/Number} sprite   Sprite name for sprite playback or sound id to continue previous.
     * @param  {Boolean} internal Internal Use: true prevents event firing.
     * @return {Number}          SoundInstance ID.
     */
    play(sprite, internal) {
      const self = this;
      let id = null;
      if (self._disposed) {
        return null;
      }

      // Determine if a sprite, sound id or nothing was passed
      if (typeof sprite === 'number') {
        id = sprite;
        sprite = null;
      } else if (typeof sprite === 'string' && self._state === 'loaded' && !self._sprite[sprite]) {
        // If the passed sprite doesn't exist, do nothing.
        return null;
      } else if (sprite === undefined) {
        // Use the default sound sprite (plays the full audio length).
        sprite = '__default';

        // Check if there is a single paused sound that isn't ended.
        // If there is, play that sound. If not, continue as usual.
        if (!self._playLock) {
          let num = 0;
          for (let i = 0; i < self._sounds.length; i++) {
            if (self._sounds[i]._paused && !self._sounds[i]._ended) {
              num++;
              id = self._sounds[i]._id;
            }
          }

          if (num === 1) {
            sprite = null;
          } else {
            id = null;
          }
        }
      }

      // Get the selected node, or get one from the pool.
      const sound = id ? self._soundById(id) : self._inactiveSound();

      // If the sound doesn't exist, do nothing.
      if (!sound) {
        return null;
      }

      // Select the sprite definition.
      if (id && !sprite) {
        sprite = sound._sprite || '__default';
      }

      // If the sound hasn't loaded, we must wait to get the audio's duration.
      // We also need to wait to make sure we don't run into race conditions with
      // the order of function calls.
      if (self._state !== 'loaded') {
        // Set the sprite value on this sound.
        sound._sprite = sprite;

        // Mark this sound as not ended in case another sound is played before this one loads.
        sound._ended = false;

        // Add the sound to the queue to be played on load.
        const soundId = sound._id;
        self._queue.push({
          event: 'play',
          action() {
            self.play(soundId);
          },
        });

        return soundId;
      }

      // Don't play the sound if an id was passed and it is already playing.
      if (id && !sound._paused) {
        // Trigger the play event, in order to keep iterating through queue.
        if (!internal) {
          self._loadQueue('play');
        }

        return sound._id;
      }

      // Make sure the AudioContext isn't suspended, and resume it if it is.
      if (self._webAudio) {
        audio._autoResume();
      }

      // Determine how long to play for and where to start playing.
      const seek = Math.max(0, sound._seek > 0 ? sound._seek : self._sprite[sprite][0] / 1000);
      const duration = Math.max(
        0,
        (self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000 - seek,
      );
      const timeout = (duration * 1000) / Math.abs(sound._rate);
      const start = self._sprite[sprite][0] / 1000;
      const stop = (self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000;
      sound._sprite = sprite;

      // Mark the sound as ended instantly so that this async playback
      // doesn't get grabbed by another call to play while this one waits to start.
      sound._ended = false;

      // Update the parameters of the sound.
      const setParams = function () {
        sound._paused = false;
        sound._seek = seek;
        sound._start = start;
        sound._stop = stop;
        sound._loop = !!(sound._loop || self._sprite[sprite][2]);
      };

      // End the sound instantly if seek is at the end.
      if (seek >= stop) {
        self._ended(sound);
        return;
      }

      // Begin the actual playback.
      const node = sound._node;
      if (self._webAudio) {
        // Fire this when the sound is ready to play to begin Web Audio playback.
        const playWebAudio = function () {
          if (!sound._node) {
            return;
          }
          self._playLock = false;
          setParams();
          self._refreshBuffer(sound);

          // Setup the playback params.
          const vol = sound._muted || self._muted ? 0 : sound._volume;
          node.gain.setValueAtTime(vol, audio.ctx.currentTime);
          sound._playStart = audio.ctx.currentTime;

          if (sound._loop) {
            node.bufferSource.start(0, seek);
          } else {
            node.bufferSource.start(0, seek, duration);
          }

          // Start a new timer if none is present.
          if (timeout !== Infinity) {
            self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
          }

          if (!internal) {
            setTimeout(() => {
              self._emit('play', sound._id);
              self._loadQueue();
            }, 0);
          }
        };

        if (audio.state === 'running' && audio.ctx.state !== 'interrupted') {
          playWebAudio();
        } else {
          self._playLock = true;

          // Wait for the audio context to resume before playing.
          self.off('resume');
          self.once('resume', playWebAudio);

          // Cancel the end timer.
          self._clearTimer(sound._id);
        }
      } else {
        // Fire this when the sound is ready to play to begin HTML5 Audio playback.
        const playHtml5 = function () {
          node.currentTime = seek;
          node.muted = sound._muted || self._muted || audio._muted || node.muted;
          node.volume = sound._volume * audio.volume();
          node.playbackRate = sound._rate;

          // Some browsers will throw an error if this is called without user interaction.
          try {
            const play = node.play();
            self._playLock = true;
            setParams();

            play.then(
              () => {
                if (sound._node !== node) {
                  return;
                }
                self._playLock = false;
                node._unlocked = true;
                if (internal) {
                  self._loadQueue();
                } else {
                  self._emit('play', sound._id);
                }
              },
              () => {
                if (sound._node !== node) {
                  return;
                }
                self._playLock = false;
                self._emit(
                  'playerror',
                  sound._id,
                  'Playback was unable to start. Start audio from a user gesture.',
                );
                sound._ended = true;
                sound._paused = true;
              },
            );

            // If the node is still paused, then we can assume there was a playback issue.
            if (node.paused) {
              self._emit(
                'playerror',
                sound._id,
                'Playback was unable to start. This is most commonly an issue ' +
                  'on mobile devices and Chrome where playback was not within a user interaction.',
              );
              return;
            }

            // Setup the end timer on sprites or listen for the ended event.
            if (sprite !== '__default' || sound._loop) {
              self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
            } else {
              const fn = function () {
                // Fire ended on this audio node.
                self._ended(sound);

                // Clear this listener.
                node.removeEventListener('ended', fn, false);
              };
              self._endTimers[sound._id] = fn;
              node.addEventListener('ended', fn, false);
            }
          } catch (error) {
            self._emit('playerror', sound._id, error);
          }
        };

        // If this is streaming audio, make sure the src is set and load again.
        if (node.src === SilentMedia) {
          node.src = self._src;
          node.load();
        }

        if (node.readyState >= 3) {
          playHtml5();
        } else {
          self._playLock = true;
          self._state = 'loading';

          if (sound._readyFn) {
            node.removeEventListener(audio._canPlayEvent, sound._readyFn);
          }
          sound._readyFn = () => {
            sound._readyFn = null;
            if (sound._node === node) {
              self._state = 'loaded';
              playHtml5();
            }
          };
          node.addEventListener(audio._canPlayEvent, sound._readyFn, { once: true });

          // Cancel the end timer.
          self._clearTimer(sound._id);
        }
      }

      return sound._id;
    },

    /**
     * Pause playback and save current position.
     * @param  {Number} id The sound ID (empty to pause all in group).
     * @return {Sound}
     */
    pause(id) {
      const self = this;

      // If the sound hasn't loaded or a play() promise is pending, add it to the load queue to pause when capable.
      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({
          event: 'pause',
          action() {
            self.pause(id);
          },
        });

        return self;
      }

      // If no id is passed, get all ID's to be paused.
      const ids = self._getSoundIds(id);

      for (let i = 0; i < ids.length; i++) {
        // Clear the end timer.
        self._clearTimer(ids[i]);

        // Get the sound.
        const sound = self._soundById(ids[i]);

        if (sound && !sound._paused) {
          // Reset the seek position.
          sound._seek = self.seek(ids[i]);
          sound._rateSeek = 0;
          sound._paused = true;

          // Stop currently running fades.
          self._stopFade(ids[i]);

          if (sound._node) {
            if (self._webAudio) {
              // Make sure the sound has been created.
              if (!sound._node.bufferSource) {
                continue;
              }

              sound._node.bufferSource.stop(0);

              // Clean up the buffer source.
              self._cleanBuffer(sound._node);
            } else if (
              !Number.isNaN(Number(sound._node.duration)) ||
              sound._node.duration === Infinity
            ) {
              sound._node.pause();
            }
          }
        }

        // Fire the pause event, unless `true` is passed as the 2nd argument.
        if (!arguments[1]) {
          self._emit('pause', sound ? sound._id : null);
        }
      }

      return self;
    },

    /**
     * Stop playback and reset to start.
     * @param  {Number} id The sound ID (empty to stop all in group).
     * @param  {Boolean} internal Internal Use: true prevents event firing.
     * @return {Sound}
     */
    stop(id, internal) {
      const self = this;

      // If the sound hasn't loaded, add it to the load queue to stop when capable.
      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({
          event: 'stop',
          action() {
            self.stop(id);
          },
        });

        return self;
      }

      // If no id is passed, get all ID's to be stopped.
      const ids = self._getSoundIds(id);

      for (let i = 0; i < ids.length; i++) {
        // Clear the end timer.
        self._clearTimer(ids[i]);

        // Get the sound.
        const sound = self._soundById(ids[i]);

        if (sound) {
          // Reset the seek position.
          sound._seek = sound._start || 0;
          sound._rateSeek = 0;
          sound._paused = true;
          sound._ended = true;

          // Stop currently running fades.
          self._stopFade(ids[i]);

          if (sound._node) {
            if (self._webAudio) {
              // Make sure the sound's AudioBufferSourceNode has been created.
              if (sound._node.bufferSource) {
                sound._node.bufferSource.stop(0);

                // Clean up the buffer source.
                self._cleanBuffer(sound._node);
              }
            } else if (
              !Number.isNaN(Number(sound._node.duration)) ||
              sound._node.duration === Infinity
            ) {
              sound._node.currentTime = sound._start || 0;
              sound._node.pause();

              // If this is a live stream, stop download once the audio is stopped.
              if (sound._node.duration === Infinity) {
                self._clearSound(sound._node);
              }
            }
          }

          if (!internal) {
            self._emit('stop', sound._id);
          }
        }
      }

      return self;
    },

    /**
     * Mute/unmute a single sound or all sounds in this Sound group.
     * @param  {Boolean} muted Set to true to mute and false to unmute.
     * @param  {Number} id    The sound ID to update (omit to mute/unmute all).
     * @return {Sound}
     */
    mute(muted, id) {
      const self = this;

      // If the sound hasn't loaded, add it to the load queue to mute when capable.
      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({
          event: 'mute',
          action() {
            self.mute(muted, id);
          },
        });

        return self;
      }

      // If applying mute/unmute to all sounds, update the group's value.
      if (id === undefined) {
        if (typeof muted === 'boolean') {
          self._muted = muted;
        } else {
          return self._muted;
        }
      }

      // If no id is passed, get all ID's to be muted.
      const ids = self._getSoundIds(id);

      for (let i = 0; i < ids.length; i++) {
        // Get the sound.
        const sound = self._soundById(ids[i]);

        if (sound) {
          sound._muted = muted;

          // Cancel active fade and set the volume to the end value.
          if (sound._interval) {
            self._stopFade(sound._id);
          }

          if (self._webAudio && sound._node) {
            sound._node.gain.setValueAtTime(muted ? 0 : sound._volume, audio.ctx.currentTime);
          } else if (sound._node) {
            sound._node.muted = audio._muted ? true : muted;
          }

          self._emit('mute', sound._id);
        }
      }

      return self;
    },

    /**
     * Get/set the volume of this sound or of the Sound group. This method can optionally take 0, 1 or 2 arguments.
     *   volume() -> Returns the group's volume value.
     *   volume(id) -> Returns the sound id's current volume.
     *   volume(vol) -> Sets the volume of all sounds in this Sound group.
     *   volume(vol, id) -> Sets the volume of passed sound id.
     * @return {Sound/Number} Returns self or current volume.
     */
    volume() {
      const self = this;
      const args = arguments;
      let vol, id;

      // Determine the values based on arguments.
      if (args.length === 0) {
        // Return the value of the groups' volume.
        return self._volume;
      } else if (args.length === 1 || (args.length === 2 && args[1] === undefined)) {
        // First check if this is an ID, and if not, assume it is a new volume.
        const ids = self._getSoundIds();
        const index = ids.indexOf(args[0]);
        if (index >= 0) {
          id = Number.parseInt(args[0], 10);
        } else {
          vol = Number.parseFloat(args[0]);
        }
      } else if (args.length >= 2) {
        vol = Number.parseFloat(args[0]);
        id = Number.parseInt(args[1], 10);
      }

      // Update the volume or return the current volume.
      let sound;
      if (vol !== undefined && vol >= 0 && vol <= 1) {
        // If the sound hasn't loaded, add it to the load queue to change volume when capable.
        if (self._state !== 'loaded' || self._playLock) {
          self._queue.push({
            event: 'volume',
            action() {
              self.volume.apply(self, args);
            },
          });

          return self;
        }

        // Set the group volume.
        if (id === undefined) {
          self._volume = vol;
        }

        // Update one or all volumes.
        id = self._getSoundIds(id);
        for (let i = 0; i < id.length; i++) {
          // Get the sound.
          sound = self._soundById(id[i]);

          if (sound) {
            sound._volume = vol;

            // Stop currently running fades.
            if (!args[2]) {
              self._stopFade(id[i]);
            }

            if (self._webAudio && sound._node && !sound._muted) {
              sound._node.gain.setValueAtTime(vol, audio.ctx.currentTime);
            } else if (sound._node && !sound._muted) {
              sound._node.volume = vol * audio.volume();
            }

            self._emit('volume', sound._id);
          }
        }
      } else {
        sound = id ? self._soundById(id) : self._sounds[0];
        return sound ? sound._volume : 0;
      }

      return self;
    },

    /**
     * Fade a currently playing sound between two volumes (if no id is passed, all sounds will fade).
     * @param  {Number} from The value to fade from (0.0 to 1.0).
     * @param  {Number} to   The volume to fade to (0.0 to 1.0).
     * @param  {Number} len  Time in milliseconds to fade.
     * @param  {Number} id   The sound id (omit to fade all sounds).
     * @return {Sound}
     */
    fade(from, to, len, id) {
      const self = this;

      // If the sound hasn't loaded, add it to the load queue to fade when capable.
      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({
          event: 'fade',
          action() {
            self.fade(from, to, len, id);
          },
        });

        return self;
      }

      // Make sure the to/from/len values are numbers.
      from = Math.min(Math.max(0, Number.parseFloat(from)), 1);
      to = Math.min(Math.max(0, Number.parseFloat(to)), 1);
      len = Number.parseFloat(len);

      // Set the volume to the start position.
      self.volume(from, id);

      // Fade the volume of one or all sounds.
      const ids = self._getSoundIds(id);
      for (let i = 0; i < ids.length; i++) {
        // Get the sound.
        const sound = self._soundById(ids[i]);

        // Create a linear fade or fall back to timeouts with HTML5 Audio.
        if (sound) {
          // Stop the previous fade if no sprite is being used (otherwise, volume handles this).
          if (!id) {
            self._stopFade(ids[i]);
          }

          // If we are using Web Audio, let the native methods do the actual fade.
          if (self._webAudio && !sound._muted) {
            const currentTime = audio.ctx.currentTime;
            const end = currentTime + len / 1000;
            sound._volume = from;
            sound._node.gain.setValueAtTime(from, currentTime);
            sound._node.gain.linearRampToValueAtTime(to, end);
          }

          self._startFadeInterval(sound, from, to, len, ids[i], id === undefined);
        }
      }

      return self;
    },

    /**
     * Starts the internal interval to fade a sound.
     * @param  {Object} sound Reference to sound to fade.
     * @param  {Number} from The value to fade from (0.0 to 1.0).
     * @param  {Number} to   The volume to fade to (0.0 to 1.0).
     * @param  {Number} len  Time in milliseconds to fade.
     * @param  {Number} id   The sound id to fade.
     * @param  {Boolean} isGroup   If true, set the volume on the group.
     */
    _startFadeInterval(sound, from, to, len, id, isGroup) {
      const self = this;
      let vol = from;
      const diff = to - from;
      const steps = Math.abs(diff / 0.01);
      const stepLen = Math.max(4, steps > 0 ? len / steps : len);
      let lastTick = Date.now();

      // Store the value being faded to.
      sound._fadeTo = to;

      // Update the volume value on each interval tick.
      sound._interval = setInterval(() => {
        // Update the volume based on the time since the last tick.
        const tick = (Date.now() - lastTick) / len;
        lastTick = Date.now();
        vol += diff * tick;

        // Round to within 2 decimal points.
        vol = Math.round(vol * 100) / 100;

        // Make sure the volume is in the right bounds.
        if (diff < 0) {
          vol = Math.max(to, vol);
        } else {
          vol = Math.min(to, vol);
        }

        // Change the volume.
        if (self._webAudio) {
          sound._volume = vol;
        } else {
          self.volume(vol, sound._id, true);
        }

        // Set the group's volume.
        if (isGroup) {
          self._volume = vol;
        }

        // When the fade is complete, stop it and fire event.
        if ((to < from && vol <= to) || (to > from && vol >= to)) {
          clearInterval(sound._interval);
          sound._interval = null;
          sound._fadeTo = null;
          self.volume(to, sound._id);
          self._emit('fade', sound._id);
        }
      }, stepLen);
    },

    /**
     * Internal method that stops the currently playing fade when
     * a new fade starts, volume is changed or the sound is stopped.
     * @param  {Number} id The sound id.
     * @return {Sound}
     */
    _stopFade(id) {
      const self = this;
      const sound = self._soundById(id);

      if (sound && sound._interval) {
        if (self._webAudio) {
          sound._node.gain.cancelScheduledValues(audio.ctx.currentTime);
        }

        clearInterval(sound._interval);
        sound._interval = null;
        self.volume(sound._fadeTo, id);
        sound._fadeTo = null;
        self._emit('fade', id);
      }

      return self;
    },

    /**
     * Get/set the loop parameter on a sound. This method can optionally take 0, 1 or 2 arguments.
     *   loop() -> Returns the group's loop value.
     *   loop(id) -> Returns the sound id's loop value.
     *   loop(loop) -> Sets the loop value for all sounds in this Sound group.
     *   loop(loop, id) -> Sets the loop value of passed sound id.
     * @return {Sound/Boolean} Returns self or current loop value.
     */
    loop() {
      const self = this;
      const args = arguments;
      let loop, id, sound;

      // Determine the values for loop and id.
      if (args.length === 0) {
        // Return the grou's loop value.
        return self._loop;
      } else if (args.length === 1) {
        if (typeof args[0] === 'boolean') {
          loop = args[0];
          self._loop = loop;
        } else {
          // Return this sound's loop value.
          sound = self._soundById(Number.parseInt(args[0], 10));
          return sound ? sound._loop : false;
        }
      } else if (args.length === 2) {
        loop = args[0];
        id = Number.parseInt(args[1], 10);
      }

      // If no id is passed, get all ID's to be looped.
      const ids = self._getSoundIds(id);
      for (let i = 0; i < ids.length; i++) {
        sound = self._soundById(ids[i]);

        if (sound) {
          sound._loop = loop;
          if (self._webAudio && sound._node && sound._node.bufferSource) {
            sound._node.bufferSource.loop = loop;
            if (loop) {
              sound._node.bufferSource.loopStart = sound._start || 0;
              sound._node.bufferSource.loopEnd = sound._stop;

              // If playing, restart playback to ensure looping updates.
              if (self.playing(ids[i])) {
                self.pause(ids[i], true);
                self.play(ids[i], true);
              }
            }
          }
        }
      }

      return self;
    },

    /**
     * Get/set the playback rate of a sound. This method can optionally take 0, 1 or 2 arguments.
     *   rate() -> Returns the first sound node's current playback rate.
     *   rate(id) -> Returns the sound id's current playback rate.
     *   rate(rate) -> Sets the playback rate of all sounds in this Sound group.
     *   rate(rate, id) -> Sets the playback rate of passed sound id.
     * @return {Sound/Number} Returns self or the current playback rate.
     */
    rate() {
      const self = this;
      const args = arguments;
      let rate, id;

      // Determine the values based on arguments.
      if (args.length === 0) {
        // We will simply return the current rate of the first node.
        id = self._sounds[0]._id;
      } else if (args.length === 1) {
        // First check if this is an ID, and if not, assume it is a new rate value.
        const ids = self._getSoundIds();
        const index = ids.indexOf(args[0]);
        if (index >= 0) {
          id = Number.parseInt(args[0], 10);
        } else {
          rate = Number.parseFloat(args[0]);
        }
      } else if (args.length === 2) {
        rate = Number.parseFloat(args[0]);
        id = Number.parseInt(args[1], 10);
      }

      // Update the playback rate or return the current value.
      let sound;
      if (typeof rate === 'number') {
        // If the sound hasn't loaded, add it to the load queue to change playback rate when capable.
        if (self._state !== 'loaded' || self._playLock) {
          self._queue.push({
            event: 'rate',
            action() {
              self.rate.apply(self, args);
            },
          });

          return self;
        }

        // Set the group rate.
        if (id === undefined) {
          self._rate = rate;
        }

        // Update one or all volumes.
        id = self._getSoundIds(id);
        for (let i = 0; i < id.length; i++) {
          // Get the sound.
          sound = self._soundById(id[i]);

          if (sound) {
            // Keep track of our position when the rate changed and update the playback
            // start position so we can properly adjust the seek position for time elapsed.
            if (self.playing(id[i])) {
              sound._rateSeek = self.seek(id[i]);
              sound._playStart = self._webAudio ? audio.ctx.currentTime : sound._playStart;
            }
            sound._rate = rate;

            // Change the playback rate.
            if (self._webAudio && sound._node && sound._node.bufferSource) {
              sound._node.bufferSource.playbackRate.setValueAtTime(rate, audio.ctx.currentTime);
            } else if (sound._node) {
              sound._node.playbackRate = rate;
            }

            // Reset the timers.
            const seek = self.seek(id[i]);
            const duration =
              (self._sprite[sound._sprite][0] + self._sprite[sound._sprite][1]) / 1000 - seek;
            const timeout = (duration * 1000) / Math.abs(sound._rate);

            // Start a new end timer if sound is already playing.
            if (self._endTimers[id[i]] || !sound._paused) {
              self._clearTimer(id[i]);
              self._endTimers[id[i]] = setTimeout(self._ended.bind(self, sound), timeout);
            }

            self._emit('rate', sound._id);
          }
        }
      } else {
        sound = self._soundById(id);
        return sound ? sound._rate : self._rate;
      }

      return self;
    },

    /**
     * Get/set the seek position of a sound. This method can optionally take 0, 1 or 2 arguments.
     *   seek() -> Returns the first sound node's current seek position.
     *   seek(id) -> Returns the sound id's current seek position.
     *   seek(seek) -> Sets the seek position of the first sound node.
     *   seek(seek, id) -> Sets the seek position of passed sound id.
     * @return {Sound/Number} Returns self or the current seek position.
     */
    seek() {
      const self = this;
      const args = arguments;
      let seek, id;

      // Determine the values based on arguments.
      if (args.length === 0) {
        // We will simply return the current position of the first node.
        if (self._sounds.length) {
          id = self._sounds[0]._id;
        }
      } else if (args.length === 1) {
        // First check if this is an ID, and if not, assume it is a new seek position.
        const ids = self._getSoundIds();
        const index = ids.indexOf(args[0]);
        if (index >= 0) {
          id = Number.parseInt(args[0], 10);
        } else if (self._sounds.length) {
          id = self._sounds[0]._id;
          seek = Number.parseFloat(args[0]);
        }
      } else if (args.length === 2) {
        seek = Number.parseFloat(args[0]);
        id = Number.parseInt(args[1], 10);
      }

      // If there is no ID, bail out.
      if (id === undefined) {
        return 0;
      }

      // If the sound hasn't loaded, add it to the load queue to seek when capable.
      if (typeof seek === 'number' && (self._state !== 'loaded' || self._playLock)) {
        self._queue.push({
          event: 'seek',
          action() {
            self.seek.apply(self, args);
          },
        });

        return self;
      }

      // Get the sound.
      const sound = self._soundById(id);

      if (sound) {
        if (typeof seek === 'number' && seek >= 0) {
          // Pause the sound and update position for restarting playback.
          const playing = self.playing(id);
          if (playing) {
            self.pause(id, true);
          }

          // Move the position of the track and cancel timer.
          sound._seek = seek;
          sound._ended = false;
          self._clearTimer(id);

          // Update the seek position for HTML5 Audio.
          if (!self._webAudio && sound._node && !Number.isNaN(Number(sound._node.duration))) {
            sound._node.currentTime = seek;
          }

          // Seek and emit when ready.
          const seekAndEmit = function () {
            // Restart the playback if the sound was playing.
            if (playing) {
              self.play(id, true);
            }

            self._emit('seek', id);
          };

          // Wait for the play lock to be unset before emitting (HTML5 Audio).
          if (playing && !self._webAudio) {
            const emitSeek = function () {
              if (!self._playLock) {
                seekAndEmit();
              } else {
                setTimeout(emitSeek, 0);
              }
            };
            setTimeout(emitSeek, 0);
          } else {
            seekAndEmit();
          }
        } else {
          if (self._webAudio) {
            const realTime = self.playing(id) ? audio.ctx.currentTime - sound._playStart : 0;
            const rateSeek = sound._rateSeek ? sound._rateSeek - sound._seek : 0;
            return sound._seek + (rateSeek + realTime * Math.abs(sound._rate));
          } else {
            return sound._node.currentTime;
          }
        }
      }

      return self;
    },

    position(id) {
      const position = id === undefined ? this.seek() : this._soundById(id) ? this.seek(id) : 0;
      return typeof position === 'number' ? position : 0;
    },

    /**
     * Check if a specific sound is currently playing or not (if id is provided), or check if at least one of the sounds in the group is playing or not.
     * @param  {Number}  id The sound id to check. If none is passed, the whole sound group is checked.
     * @return {Boolean} True if playing and false if not.
     */
    playing(id) {
      const self = this;

      // Check the passed sound ID (if any).
      if (typeof id === 'number') {
        const sound = self._soundById(id);
        return sound ? !sound._paused : false;
      }

      // Otherwise, loop through all sounds and check if any are playing.
      for (let i = 0; i < self._sounds.length; i++) {
        if (!self._sounds[i]._paused) {
          return true;
        }
      }

      return false;
    },

    /**
     * Get the duration of this sound. Passing a sound id will return the sprite duration.
     * @param  {Number} id The sound id to check. If none is passed, return full source duration.
     * @return {Number} Audio duration in seconds.
     */
    duration(id) {
      const self = this;
      let duration = self._duration;

      // If we pass an ID, get the sound and return the sprite length.
      const sound = self._soundById(id);
      if (sound) {
        duration = self._sprite[sound._sprite][1] / 1000;
      }

      return duration;
    },

    /**
     * Returns the current loaded state of this Sound.
     * @return {String} 'unloaded', 'loading', 'loaded'
     */
    state() {
      return this._state;
    },

    /**
     * Unload and destroy the current Sound object.
     * This will immediately stop all sound instances attached to this group.
     */
    unload() {
      const self = this;

      if (self._disposed) {
        return null;
      }

      self._disposed = true;
      self._state = 'unloaded';
      self._cancelRequest?.();
      self._queue.length = 0;
      self.off();
      for (const sound of self._sounds) {
        sound.destroy();
      }
      self._sounds.length = 0;

      const index = audio._soundGroups.indexOf(self);
      if (index >= 0) {
        audio._soundGroups.splice(index, 1);
      }

      const src = self._src;
      if (
        typeof src === 'string' &&
        !audio._soundGroups.some(
          (group) => group._src === src || (Array.isArray(group._src) && group._src.includes(src)),
        )
      ) {
        cache.delete(src);
      }
      audio._autoSuspend();

      return null;
    },

    /**
     * Listen to a custom event.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to call.
     * @param  {Number}   id    (optional) Only listen to events for this sound.
     * @param  {Number}   once  (INTERNAL) Marks event to fire only once.
     * @return {Sound}
     */
    on(event, fn, id, once) {
      const self = this;
      const events = self['_on' + event];

      if (typeof fn === 'function') {
        events.push(once ? { id, fn, once } : { id, fn });
      }

      return self;
    },

    /**
     * Remove a custom event. Call without parameters to remove all events.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to remove. Leave empty to remove all.
     * @param  {Number}   id    (optional) Only remove events for this sound.
     * @return {Sound}
     */
    off(event, fn, id) {
      const self = this;
      const events = self['_on' + event];
      let i = 0;

      // Allow passing just an event and ID.
      if (typeof fn === 'number') {
        id = fn;
        fn = null;
      }

      if (fn || id) {
        // Loop through event store and remove the passed function.
        for (i = 0; i < events.length; i++) {
          const isId = id === events[i].id;
          if ((fn === events[i].fn && isId) || (!fn && isId)) {
            events.splice(i, 1);
            break;
          }
        }
      } else if (event) {
        // Clear out all events of this type.
        self['_on' + event] = [];
      } else {
        // Clear out all events of every type.
        const keys = Object.keys(self);
        for (i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('_on') === 0 && Array.isArray(self[keys[i]])) {
            self[keys[i]] = [];
          }
        }
      }

      return self;
    },

    /**
     * Listen to a custom event and remove it once fired.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to call.
     * @param  {Number}   id    (optional) Only listen to events for this sound.
     * @return {Sound}
     */
    once(event, fn, id) {
      const self = this;

      // Setup the event listener.
      self.on(event, fn, id, 1);

      return self;
    },

    /**
     * Emit all events of a specific type and pass the sound id.
     * @param  {String} event Event name.
     * @param  {Number} id    SoundInstance ID.
     * @param  {Number} msg   Message to go with event.
     * @return {Sound}
     */
    _emit(event, id, msg) {
      const self = this;
      const events = self['_on' + event];

      // Loop through event store and fire all functions.
      for (let i = events.length - 1; i >= 0; i--) {
        // Only fire the listener if the correct ID is used.
        if (!events[i].id || events[i].id === id || event === 'load') {
          const { fn } = events[i];
          setTimeout(() => {
            if (!self._disposed) {
              fn.call(self, id, msg);
            }
          }, 0);

          // If this event was setup with `once`, remove it.
          if (events[i].once) {
            self.off(event, events[i].fn, events[i].id);
          }
        }
      }

      // Pass the event type into load queue so that it can continue stepping.
      self._loadQueue(event);

      return self;
    },

    /**
     * Queue of actions initiated before the sound has loaded.
     * These will be called in sequence, with the next only firing
     * after the previous has finished executing (even if async like play).
     * @return {Sound}
     */
    _loadQueue(event) {
      const self = this;

      if (self._queue.length > 0) {
        const task = self._queue[0];

        // Remove this task if a matching event was passed.
        if (task.event === event) {
          self._queue.shift();
          self._loadQueue();
        }

        // Run the task if no event type is passed.
        if (!event) {
          task.action();
        }
      }

      return self;
    },

    /**
     * Fired when playback ends at the end of the duration.
     * @param  {SoundInstance} sound The sound object to work with.
     * @return {Sound}
     */
    _ended(sound) {
      const self = this;
      const sprite = sound._sprite;

      if (
        !self._webAudio &&
        sound._node &&
        !sound._node.paused &&
        !sound._node.ended &&
        sound._node.currentTime < sound._stop
      ) {
        self._endTimers[sound._id] = setTimeout(() => self._ended(sound), 100);
        return self;
      }

      // Should this sound loop?
      const loop = !!(sound._loop || self._sprite[sprite][2]);

      // Fire the ended event.
      self._emit('end', sound._id);

      // Restart the playback for HTML5 Audio loop.
      if (!self._webAudio && loop) {
        self.stop(sound._id, true).play(sound._id);
      }

      // Restart this timer if on a Web Audio loop.
      if (self._webAudio && loop) {
        self._emit('play', sound._id);
        sound._seek = sound._start || 0;
        sound._rateSeek = 0;
        sound._playStart = audio.ctx.currentTime;

        const timeout = ((sound._stop - sound._start) * 1000) / Math.abs(sound._rate);
        self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
      }

      // Mark the node as paused.
      if (self._webAudio && !loop) {
        sound._paused = true;
        sound._ended = true;
        sound._seek = sound._start || 0;
        sound._rateSeek = 0;
        self._clearTimer(sound._id);

        // Clean up the buffer source.
        self._cleanBuffer(sound._node);

        // Attempt to auto-suspend AudioContext if no sounds are still playing.
        audio._autoSuspend();
      }

      // When using a sprite, end the track.
      if (!self._webAudio && !loop) {
        self.stop(sound._id, true);
      }

      return self;
    },

    /**
     * Clear the end timer for a sound playback.
     * @param  {Number} id The sound ID.
     * @return {Sound}
     */
    _clearTimer(id) {
      const self = this;

      if (self._endTimers[id]) {
        // Clear the timeout or remove the ended listener.
        if (typeof self._endTimers[id] !== 'function') {
          clearTimeout(self._endTimers[id]);
        } else {
          const sound = self._soundById(id);
          if (sound && sound._node) {
            sound._node.removeEventListener('ended', self._endTimers[id], false);
          }
        }

        delete self._endTimers[id];
      }

      return self;
    },

    /**
     * Return the sound identified by this ID, or return null.
     * @param  {Number} id SoundInstance ID
     * @return {Object}    SoundInstance object or null.
     */
    _soundById(id) {
      const self = this;

      // Loop through all sounds and find the one with this ID.
      for (let i = 0; i < self._sounds.length; i++) {
        if (id === self._sounds[i]._id) {
          return self._sounds[i];
        }
      }

      return null;
    },

    /**
     * Return an inactive sound from the pool or create a new one.
     * @return {SoundInstance} SoundInstance playback object.
     */
    _inactiveSound() {
      const self = this;

      self._drain();

      // Find the first inactive node to recycle.
      for (let i = 0; i < self._sounds.length; i++) {
        if (self._sounds[i]._ended) {
          return self._sounds[i].reset();
        }
      }

      // If no inactive node was found, create a new one.
      return new SoundInstance(self);
    },

    /**
     * Drain excess inactive sounds from the pool.
     */
    _drain() {
      const self = this;
      const limit = self._pool;
      let cnt = 0;
      let i = 0;

      // If there are less sounds than the max pool size, we are done.
      if (self._sounds.length < limit) {
        return;
      }

      // Count the number of inactive sounds.
      for (i = 0; i < self._sounds.length; i++) {
        if (self._sounds[i]._ended) {
          cnt++;
        }
      }

      // Remove excess inactive sounds, going in reverse order.
      for (i = self._sounds.length - 1; i >= 0; i--) {
        if (cnt <= limit) {
          return;
        }

        if (self._sounds[i]._ended) {
          self._sounds[i].destroy();

          // Remove sounds until we have the pool size.
          self._sounds.splice(i, 1);
          cnt--;
        }
      }
    },

    /**
     * Get all ID's from the sounds pool.
     * @param  {Number} id Only return one ID if one is passed.
     * @return {Array}    Array of IDs.
     */
    _getSoundIds(id) {
      const self = this;

      if (id === undefined) {
        const ids = [];
        for (let i = 0; i < self._sounds.length; i++) {
          ids.push(self._sounds[i]._id);
        }

        return ids;
      } else {
        return [id];
      }
    },

    /**
     * Load the sound back into the buffer source.
     * @param  {SoundInstance} sound The sound object to work with.
     * @return {Sound}
     */
    _refreshBuffer(sound) {
      const self = this;

      // Setup the buffer source for playback.
      sound._node.bufferSource = audio.ctx.createBufferSource();
      sound._node.bufferSource.buffer = cache.get(self._src);

      // Connect to the correct node.
      if (sound._panner) {
        sound._node.bufferSource.connect(sound._panner);
      } else {
        sound._node.bufferSource.connect(sound._node);
      }

      // Setup looping and playback rate.
      sound._node.bufferSource.loop = sound._loop;
      if (sound._loop) {
        sound._node.bufferSource.loopStart = sound._start || 0;
        sound._node.bufferSource.loopEnd = sound._stop || 0;
      }
      sound._node.bufferSource.playbackRate.setValueAtTime(sound._rate, audio.ctx.currentTime);

      return self;
    },

    /**
     * Prevent memory leaks by cleaning up the buffer source after playback.
     * @param  {Object} node SoundInstance's audio node containing the buffer source.
     * @return {Sound}
     */
    _cleanBuffer(node) {
      const self = this;
      const isIOS = audio._navigator?.vendor?.includes('Apple');

      if (!node.bufferSource) {
        return self;
      }

      node.bufferSource.onended = null;
      node.bufferSource.disconnect();
      if (isIOS && audio._scratchBuffer) {
        try {
          node.bufferSource.buffer = audio._scratchBuffer;
        } catch {}
      }
      node.bufferSource = null;

      return self;
    },

    /**
     * Set the source to a 0-second silence to stop any downloading.
     * @param  {Object} node Audio node to clear.
     */
    _clearSound(node) {
      node.src = SilentMedia;
    },
  };

  /** Single SoundInstance Methods **/
  /***************************************************************************/

  /**
   * Setup the sound object, which each node attached to a Sound group is contained in.
   * @param {Object} howl The Sound parent group.
   */
  function SoundInstance(howl) {
    this._parent = howl;
    this.init();
  }
  SoundInstance.prototype = {
    /**
     * Initialize a new SoundInstance object.
     * @return {SoundInstance}
     */
    init() {
      const self = this;
      const parent = self._parent;

      // Setup the default parameters.
      self._muted = parent._muted;
      self._loop = parent._loop;
      self._volume = parent._volume;
      self._rate = parent._rate;
      self._seek = 0;
      self._paused = true;
      self._ended = true;
      self._sprite = '__default';

      // Generate a unique ID for this sound.
      self._id = ++audio._counter;

      // Add itself to the parent's pool.
      parent._sounds.push(self);

      // Create the new node.
      self.create();

      return self;
    },

    /**
     * Create and setup a new sound object, whether HTML5 Audio or Web Audio.
     * @return {SoundInstance}
     */
    create() {
      const self = this;
      const parent = self._parent;
      const volume = audio._muted || self._muted || self._parent._muted ? 0 : self._volume;

      if (parent._webAudio) {
        // Create the gain node for controlling volume (the source will connect to this).
        self._node = audio.ctx.createGain();
        self._node.gain.setValueAtTime(volume, audio.ctx.currentTime);
        self._node.paused = true;
        self._node.connect(audio.masterGain);
      } else if (!audio.noAudio) {
        // Get an unlocked Audio object from the pool.
        self._node = audio._obtainHtml5Audio();

        // Listen for errors (http://dev.w3.org/html5/spec-author-view/spec.html#mediaerror).
        self._errorFn = self._errorListener.bind(self);
        self._node.addEventListener('error', self._errorFn, false);

        // Listen for 'canplaythrough' event to let us know the sound is ready.
        self._loadFn = self._loadListener.bind(self);
        self._node.addEventListener(audio._canPlayEvent, self._loadFn, false);

        // Listen for the 'ended' event on the sound to account for edge-case where
        // a finite sound has a duration of Infinity.
        self._endFn = self._endListener.bind(self);
        self._node.addEventListener('ended', self._endFn, false);

        // Setup the new audio node.
        self._node.src = parent._src;
        self._node.preload = parent._preload === true ? 'auto' : parent._preload;
        self._node.volume = volume * audio.volume();

        // Begin loading the source.
        self._node.load();
      }

      return self;
    },

    destroy() {
      const { _node: node, _parent: parent } = this;
      parent._clearTimer(this._id);
      clearInterval(this._interval);
      this._interval = null;
      if (!node) {
        return;
      }

      if (parent._webAudio) {
        node.bufferSource?.stop();
        parent._cleanBuffer(node);
        this._panner?.disconnect();
        this._panner = null;
        node.disconnect();
      } else {
        node.removeEventListener('error', this._errorFn);
        node.removeEventListener(audio._canPlayEvent, this._loadFn);
        node.removeEventListener(audio._canPlayEvent, this._readyFn);
        node.removeEventListener('ended', this._endFn);
        this._readyFn = null;
        node.pause();
        parent._clearSound(node);
        audio._releaseHtml5Audio(node);
      }
      this._node = null;
    },

    /**
     * Reset the parameters of this sound to the original state (for recycle).
     * @return {SoundInstance}
     */
    reset() {
      const self = this;
      const parent = self._parent;

      // Reset all of the parameters of this sound.
      self._muted = parent._muted;
      self._loop = parent._loop;
      self._volume = parent._volume;
      self._rate = parent._rate;
      self._seek = 0;
      self._rateSeek = 0;
      self._paused = true;
      self._ended = true;
      self._sprite = '__default';

      // Generate a new ID so that it isn't confused with the previous sound.
      self._id = ++audio._counter;

      return self;
    },

    /**
     * HTML5 Audio error listener callback.
     */
    _errorListener() {
      const self = this;

      // Fire an error event and pass back the code.
      self._parent._emit('loaderror', self._id, self._node.error ? self._node.error.code : 0);

      // Clear the event listener.
      self._node.removeEventListener('error', self._errorFn, false);
    },

    /**
     * HTML5 Audio canplaythrough listener callback.
     */
    _loadListener() {
      const self = this;
      const parent = self._parent;

      // Round up the duration to account for the lower precision in HTML5 Audio.
      parent._duration = Math.ceil(self._node.duration * 10) / 10;

      // Setup a sprite if none is defined.
      if (Object.keys(parent._sprite).length === 0) {
        parent._sprite = { __default: [0, parent._duration * 1000] };
      }

      if (parent._state !== 'loaded') {
        parent._state = 'loaded';
        parent._emit('load');
        parent._loadQueue();
      }

      // Clear the event listener.
      self._node.removeEventListener(audio._canPlayEvent, self._loadFn, false);
    },

    /**
     * HTML5 Audio ended listener callback.
     */
    _endListener() {
      const self = this;
      const parent = self._parent;

      // Only handle the `ended`` event if the duration is Infinity.
      if (parent._duration === Infinity) {
        // Update the parent duration to match the real audio duration.
        // Round up the duration to account for the lower precision in HTML5 Audio.
        parent._duration = Math.ceil(self._node.duration * 10) / 10;

        // Update the sprite that corresponds to the real duration.
        if (parent._sprite.__default[1] === Infinity) {
          parent._sprite.__default[1] = parent._duration * 1000;
        }

        // Run the regular ended method.
        parent._ended(self);
      }

      // Clear the event listener since the duration is now correct.
      self._node.removeEventListener('ended', self._endFn, false);
    },
  };

  /** Helper Methods **/
  /***************************************************************************/

  const cache = new Map();

  /**
   * Buffer a sound from URL, Data URI or cache and decode to audio source (Web Audio API).
   * @param  {Sound} self
   */
  function loadBuffer(self) {
    const url = self._src;

    // Check if the buffer has already been cached and use it instead.
    const cached = cache.get(url);
    if (cached) {
      // Set the duration from the cache.
      self._duration = cached.duration;

      // Load the sound into this Sound.
      loadSound(self);

      return;
    }

    if (/^data:[^;]+;base64,/.test(url)) {
      // Decode the base64 data URI without XHR, since some browsers don't support it.
      const data = atob(url.split(',')[1]);
      const dataView = new Uint8Array(data.length);
      for (let i = 0; i < data.length; ++i) {
        dataView[i] = data.charCodeAt(i);
      }

      decodeAudioData(dataView.buffer, self);
    } else {
      // Load the buffer from the URL.
      const xhr = new XMLHttpRequest();
      xhr.open(self._xhr.method, url, true);
      xhr.withCredentials = self._xhr.withCredentials;
      xhr.responseType = 'arraybuffer';

      // Apply any custom headers to the request.
      if (self._xhr.headers) {
        Object.keys(self._xhr.headers).forEach((key) => {
          xhr.setRequestHeader(key, self._xhr.headers[key]);
        });
      }

      const clearRequest = () => {
        self._cancelRequest = null;
        xhr.onload = xhr.onerror = null;
      };
      self._cancelRequest = () => {
        clearRequest();
        xhr.abort();
      };

      xhr.onload = () => {
        clearRequest();
        const code = String(xhr.status)[0];
        if (code !== '0' && code !== '2' && code !== '3') {
          self._state = 'unloaded';
          self._emit(
            'loaderror',
            null,
            'Failed loading audio file with status: ' + xhr.status + '.',
          );
          return;
        }
        decodeAudioData(xhr.response, self);
      };
      xhr.onerror = () => {
        clearRequest();
        for (const sound of self._sounds) {
          sound.destroy();
        }
        self._html5 = true;
        self._webAudio = false;
        for (const sound of self._sounds) {
          sound.create();
        }
      };
      safeXhrSend(xhr);
    }
  }

  /**
   * Send the XHR request wrapped in a try/catch.
   * @param  {Object} xhr XHR to send.
   */
  function safeXhrSend(xhr) {
    try {
      xhr.send();
    } catch {
      xhr.onerror();
    }
  }

  /**
   * Decode audio data from an array buffer.
   * @param  {ArrayBuffer} arraybuffer The audio data.
   * @param  {Sound}        self
   */
  function decodeAudioData(arraybuffer, self) {
    audio.ctx.decodeAudioData(arraybuffer).then(
      (buffer) => {
        if (!self._disposed) {
          cache.set(self._src, buffer);
          loadSound(self, buffer);
        }
      },
      () => {
        if (!self._disposed) {
          self._state = 'unloaded';
          self._emit('loaderror', null, 'Decoding audio data failed.');
        }
      },
    );
  }

  /**
   * SoundInstance is now loaded, so finish setting everything up and fire the loaded event.
   * @param  {Sound} self
   * @param  {Object} buffer The decoded buffer sound source.
   */
  const loadSound = function (self, buffer) {
    // Set the duration.
    if (buffer && !self._duration) {
      self._duration = buffer.duration;
    }

    // Setup a sprite if none is defined.
    if (Object.keys(self._sprite).length === 0) {
      self._sprite = { __default: [0, self._duration * 1000] };
    }

    // Fire the loaded event.
    if (self._state !== 'loaded') {
      self._state = 'loaded';
      self._emit('load');
      self._loadQueue();
    }
  };

  /**
   * Setup the audio context when available, or switch to HTML5 Audio mode.
   */
  function setupAudioContext() {
    // If we have already detected that Web Audio isn't supported, don't run this step again.
    if (lifetime.signal.aborted || !audio.usingWebAudio) {
      return;
    }

    try {
      audio.ctx = globalThis.AudioContext === undefined ? null : new AudioContext();
    } catch {
      audio.ctx = null;
    }
    audio.usingWebAudio = Boolean(audio.ctx);

    // Create and expose the master GainNode when using Web Audio (useful for plugins or advanced usage).
    if (audio.usingWebAudio) {
      audio.masterGain = audio.ctx.createGain();
      audio.masterGain.gain.setValueAtTime(audio._muted ? 0 : audio._volume, audio.ctx.currentTime);
      audio.masterGain.connect(audio.ctx.destination);
    }

    // Re-run the setup on audio.
    audio._setup();
  }

  function prepareOutput() {
    if (!audio.ctx) {
      setupAudioContext();
    }
    if (audio.ctx && audio.autoUnlock && globalThis.document !== undefined) {
      audio._unlockAudio();
    }
  }

  function getOutput() {
    prepareOutput();
    if (!audio.usingWebAudio || !audio.ctx) {
      return null;
    }
    return {
      context: audio.ctx,
      destination: audio.masterGain,
      retain: audio.retainAudioContext.bind(audio),
      signal: lifetime.signal,
    };
  }

  function dispose() {
    if (!disposePromise) {
      const context = audio.ctx;
      disposePromise = Promise.resolve().then(() => {
        if (context && context.state !== 'closed') {
          return context.close();
        }
      });
      lifetime.abort();
      audio._removeUnlockListeners?.();
      for (let index = audio._soundGroups.length - 1; index >= 0; index--) {
        audio._soundGroups[index].unload();
      }
      clearTimeout(audio._suspendTimer);
      audio._suspendTimer = null;
      audio._html5AudioPool.length = 0;
      cache.clear();
      audio._scratchBuffer = null;
      audio.ctx = null;
      audio.masterGain = null;
      audio.usingWebAudio = false;
    }
    return disposePromise;
  }

  installSpatial(audio, AudioController, Sound, SoundInstance);

  return {
    codecs: (extension) => Boolean(audio.codecs(extension)),
    dispose,
    getOutput,
    mute(muted) {
      audio.mute(muted);
    },
    orientation(x, y, z, upX, upY, upZ) {
      if (x === undefined) {
        return [...audio._orientation];
      }
      audio.orientation(x, y, z, upX, upY, upZ);
    },
    pos(x, y, z) {
      if (x === undefined) {
        return [...audio._pos];
      }
      audio.pos(x, y, z);
    },
    sound(options) {
      if (lifetime.signal.aborted) {
        throw new Error('The audio instance has been disposed.');
      }
      if (!options.src?.length) {
        throw new TypeError('At least one sound source is required.');
      }
      return new Sound(options);
    },
    stereo(pan) {
      audio.stereo(pan);
    },
    stop() {
      audio.stop();
    },
    volume(value) {
      if (value === undefined) {
        return audio._volume;
      }
      audio.volume(value);
    },
  };
}
