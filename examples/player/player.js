/*!
 *  @nkzw/audio Audio Player Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

import { createAudio } from '../../lib/index.js';
import { SiriWave } from './siriwave.js';

const audio = createAudio();

// Cache references to DOM elements.
const {
  bar,
  barEmpty,
  barFull,
  duration,
  list,
  loading,
  nextBtn,
  pauseBtn,
  playBtn,
  playlist,
  playlistBtn,
  prevBtn,
  progress,
  sliderBtn,
  timer,
  track,
  volume,
  volumeBtn,
  waveform,
} = Object.fromEntries(
  [
    'track',
    'timer',
    'duration',
    'playBtn',
    'pauseBtn',
    'prevBtn',
    'nextBtn',
    'playlistBtn',
    'volumeBtn',
    'progress',
    'bar',
    'loading',
    'playlist',
    'list',
    'volume',
    'barEmpty',
    'barFull',
    'sliderBtn',
    'waveform',
  ].map((id) => [id, document.getElementById(id)]),
);

/**
 * Player class containing the state of our playlist and where we are in it.
 * Includes all methods for playing, skipping, updating the display, etc.
 * @param {Array} playlist Array of objects with playlist song details ({title, file, sound}).
 */
const Player = function (playlist) {
  this.playlist = playlist;
  this.index = 0;

  // Display the title of the first track.
  track.innerHTML = '1. ' + playlist[0].title;

  // Setup the playlist display.
  playlist.forEach((song) => {
    const div = document.createElement('div');
    div.className = 'list-song';
    div.innerHTML = song.title;
    div.onclick = function () {
      player.skipTo(playlist.indexOf(song));
    };
    list.append(div);
  });
};
Player.prototype = {
  /**
   * Play a song in the playlist.
   * @param  {Number} index Index of the song in the playlist (leave empty to play the first or current).
   */
  play(index) {
    const self = this;
    let sound;

    index = typeof index === 'number' ? index : self.index;
    const data = self.playlist[index];

    // If we already loaded this track, use the current one.
    // Otherwise, setup and load a sound.
    if (data.sound) {
      sound = data.sound;
    } else {
      sound = data.sound = audio.sound({
        html5: true, // Force to HTML5 so that the audio can stream in (best for large files).
        onend() {
          // Stop the wave animation.
          wave.container.style.display = 'none';
          bar.style.display = 'block';
          self.skip('next');
        },
        onload() {
          // Start the wave animation.
          wave.container.style.display = 'block';
          bar.style.display = 'none';
          loading.style.display = 'none';
        },
        onpause() {
          // Stop the wave animation.
          wave.container.style.display = 'none';
          bar.style.display = 'block';
        },
        onplay() {
          // Display the duration.
          duration.innerHTML = self.formatTime(Math.round(sound.duration()));

          // Start updating the progress of the track.
          requestAnimationFrame(self.step.bind(self));

          // Start the wave animation if we have already loaded
          wave.container.style.display = 'block';
          bar.style.display = 'none';
          pauseBtn.style.display = 'block';
        },
        onseek() {
          // Start updating the progress of the track.
          requestAnimationFrame(self.step.bind(self));
        },
        onstop() {
          // Stop the wave animation.
          wave.container.style.display = 'none';
          bar.style.display = 'block';
        },
        src: ['./audio/' + data.file + '.webm', './audio/' + data.file + '.mp3'],
      });
    }

    // Begin playing the sound.
    sound.play();

    // Update the track display.
    track.innerHTML = index + 1 + '. ' + data.title;

    // Show the pause button.
    if (sound.state() === 'loaded') {
      playBtn.style.display = 'none';
      pauseBtn.style.display = 'block';
    } else {
      loading.style.display = 'block';
      playBtn.style.display = 'none';
      pauseBtn.style.display = 'none';
    }

    // Keep track of the index we are currently playing.
    self.index = index;
  },

  /**
   * Pause the currently playing track.
   */
  pause() {
    const self = this;

    // Get the Sound we want to manipulate.
    const sound = self.playlist[self.index].sound;

    // Puase the sound.
    sound.pause();

    // Show the play button.
    playBtn.style.display = 'block';
    pauseBtn.style.display = 'none';
  },

  /**
   * Skip to the next or previous track.
   * @param  {String} direction 'next' or 'prev'.
   */
  skip(direction) {
    const self = this;

    // Get the next track based on the direction of the track.
    let index = 0;
    if (direction === 'prev') {
      index = self.index - 1;
      if (index < 0) {
        index = self.playlist.length - 1;
      }
    } else {
      index = self.index + 1;
      if (index >= self.playlist.length) {
        index = 0;
      }
    }

    self.skipTo(index);
  },

  /**
   * Skip to a specific track based on its playlist index.
   * @param  {Number} index Index in the playlist.
   */
  skipTo(index) {
    const self = this;

    // Stop the current track.
    if (self.playlist[self.index].sound) {
      self.playlist[self.index].sound.stop();
    }

    // Reset progress.
    progress.style.width = '0%';

    // Play the new track.
    self.play(index);
  },

  /**
   * Set the volume and update the volume slider display.
   * @param  {Number} val Volume between 0 and 1.
   */
  volume(val) {
    // Update the global volume (affecting all Sound).
    audio.volume(val);

    // Update the display on the slider.
    const barWidth = (val * 90) / 100;
    barFull.style.width = barWidth * 100 + '%';
    sliderBtn.style.left = window.innerWidth * barWidth + window.innerWidth * 0.05 - 25 + 'px';
  },

  /**
   * Seek to a new position in the currently playing track.
   * @param  {Number} per Percentage through the song to skip.
   */
  seek(per) {
    const self = this;

    // Get the Sound we want to manipulate.
    const sound = self.playlist[self.index].sound;

    // Convert the percent into a seek position.
    if (sound?.playing()) {
      sound.seek(sound.duration() * per);
    }
  },

  /**
   * The step called within requestAnimationFrame to update the playback position.
   */
  step() {
    const self = this;

    // Get the Sound we want to manipulate.
    const sound = self.playlist[self.index].sound;

    // Determine our current seek position.
    const seek = sound.seek() || 0;
    timer.innerHTML = self.formatTime(Math.round(seek));
    progress.style.width = ((seek / sound.duration()) * 100 || 0) + '%';

    // If the sound is still playing, continue stepping.
    if (sound.playing()) {
      requestAnimationFrame(self.step.bind(self));
    }
  },

  /**
   * Toggle the playlist display on/off.
   */
  togglePlaylist() {
    const display = playlist.style.display === 'block' ? 'none' : 'block';

    setTimeout(
      () => {
        playlist.style.display = display;
      },
      display === 'block' ? 0 : 500,
    );
    playlist.className = display === 'block' ? 'fadein' : 'fadeout';
  },

  /**
   * Toggle the volume display on/off.
   */
  toggleVolume() {
    const display = volume.style.display === 'block' ? 'none' : 'block';

    setTimeout(
      () => {
        volume.style.display = display;
      },
      display === 'block' ? 0 : 500,
    );
    volume.className = display === 'block' ? 'fadein' : 'fadeout';
  },

  /**
   * Format the time from seconds to M:SS.
   * @param  {Number} secs Seconds to format.
   * @return {String}      Formatted time.
   */
  formatTime(secs) {
    const minutes = Math.floor(secs / 60) || 0;
    const seconds = secs - minutes * 60 || 0;

    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  },
};

// Setup our new audio player class and pass it the playlist.
const player = new Player([
  {
    file: 'rave_digger',
    sound: null,
    title: 'Rave Digger',
  },
  {
    file: '80s_vibe',
    sound: null,
    title: '80s Vibe',
  },
  {
    file: 'running_out',
    sound: null,
    title: 'Running Out',
  },
]);

// Bind our player controls.
playBtn.addEventListener('click', () => {
  player.play();
});
pauseBtn.addEventListener('click', () => {
  player.pause();
});
prevBtn.addEventListener('click', () => {
  player.skip('prev');
});
nextBtn.addEventListener('click', () => {
  player.skip('next');
});
waveform.addEventListener('click', (event) => {
  player.seek(event.clientX / window.innerWidth);
});
playlistBtn.addEventListener('click', () => {
  player.togglePlaylist();
});
playlist.addEventListener('click', () => {
  player.togglePlaylist();
});
volumeBtn.addEventListener('click', () => {
  player.toggleVolume();
});
volume.addEventListener('click', () => {
  player.toggleVolume();
});

// Setup the event listeners to enable dragging of volume slider.
barEmpty.addEventListener('click', (event) => {
  const per = event.layerX / Number.parseFloat(barEmpty.scrollWidth);
  player.volume(per);
});
let sliderDown = false;
sliderBtn.addEventListener('mousedown', () => {
  sliderDown = true;
});
sliderBtn.addEventListener('touchstart', () => {
  sliderDown = true;
});
volume.addEventListener('mouseup', () => {
  sliderDown = false;
});
volume.addEventListener('touchend', () => {
  sliderDown = false;
});

const move = function (event) {
  if (sliderDown) {
    const x = event.clientX || event.touches[0].clientX;
    const startX = window.innerWidth * 0.05;
    const layerX = x - startX;
    const per = Math.min(1, Math.max(0, layerX / Number.parseFloat(barEmpty.scrollWidth)));
    player.volume(per);
  }
};

volume.addEventListener('mousemove', move);
volume.addEventListener('touchmove', move);

// Setup the "waveform" animation.
const wave = new SiriWave({
  amplitude: 0.7,
  container: waveform,
  cover: true,
  frequency: 2,
  height: window.innerHeight * 0.3,
  speed: 0.03,
  width: window.innerWidth,
});
wave.start();

// Update the height of the wave animation.
// These are basically some hacks to get SiriWave.js to do what we want.
const resize = function () {
  const height = window.innerHeight * 0.3;
  const width = window.innerWidth;
  wave.height = height;
  wave.height_2 = height / 2;
  wave.MAX = wave.height_2 - 4;
  wave.width = width;
  wave.width_2 = width / 2;
  wave.width_4 = width / 4;
  wave.canvas.height = height;
  wave.canvas.width = width;
  wave.container.style.margin = -(height / 2) + 'px auto';

  // Update the position of the slider.
  const sound = player.playlist[player.index].sound;
  if (sound) {
    const vol = sound.volume();
    const barWidth = vol * 0.9;
    sliderBtn.style.left = window.innerWidth * barWidth + window.innerWidth * 0.05 - 25 + 'px';
  }
};
window.addEventListener('resize', resize);
resize();
