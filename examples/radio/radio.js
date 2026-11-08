/*!
 *  @nkzw/audio Radio Demo
 *
 *  Copyright (c) 2013-2020 James Simpson and GoldFire Studios, Inc.
 *  Copyright (c) 2026 Nakazawa Tech
 *
 *  SPDX-License-Identifier: MIT
 */

import { createAudio } from '../../lib/index.js';

const audio = createAudio();

/**
 * Radio class containing the state of our stations.
 * Includes all methods for playing, stopping, etc.
 * @param {Array} stations Array of objects with station details ({title, src, sound, ...}).
 */
const Radio = function (stations) {
  const self = this;

  self.stations = stations;
  self.index = 0;

  // Setup the display for each station.
  for (let i = 0; i < self.stations.length; i++) {
    document.getElementById('title' + i).innerHTML =
      '<b>' + self.stations[i].freq + '</b> ' + self.stations[i].title;
    document.getElementById('station' + i).addEventListener('click', () => {
      const shouldPlay = i !== self.index || !self.stations[i].sound;
      self.stop();
      if (shouldPlay) {
        self.play(i);
      }
    });
  }
};
Radio.prototype = {
  /**
   * Play a station with a specific index.
   * @param  {Number} index Index in the array of stations.
   */
  play(index) {
    const self = this;
    let sound;

    index = typeof index === 'number' ? index : self.index;
    const data = self.stations[index];

    // If we already loaded this track, use the current one.
    // Otherwise, setup and load a sound.
    if (data.sound) {
      sound = data.sound;
    } else {
      sound = data.sound = audio.sound({
        format: ['mp3', 'aac'],
        html5: true, // A live stream can only be played through HTML5 Audio.
        src: data.src,
      });
    }

    // Begin playing the sound.
    sound.play();

    // Toggle the display.
    self.toggleStationDisplay(index, true);

    // Keep track of the index we are currently playing.
    self.index = index;
  },

  /**
   * Stop a station's live stream.
   */
  stop() {
    const self = this;

    // Get the Sound we want to manipulate.
    const sound = self.stations[self.index].sound;

    // Toggle the display.
    self.toggleStationDisplay(self.index, false);

    if (sound) {
      sound.unload();
      self.stations[self.index].sound = null;
    }
  },

  /**
   * Toggle the display of a station to off/on.
   * @param  {Number} index Index of the station to toggle.
   * @param  {Boolean} state true is on and false is off.
   */
  toggleStationDisplay(index, state) {
    // Highlight/un-highlight the row.
    document.getElementById('station' + index).style.backgroundColor = state
      ? 'rgba(255, 255, 255, 0.33)'
      : '';

    // Show/hide the "live" marker.
    document.getElementById('live' + index).style.opacity = state ? 1 : 0;

    // Show/hide the "playing" animation.
    document.getElementById('playing' + index).style.display = state ? 'block' : 'none';
  },
};

// Setup our new radio and pass in the stations.
new Radio([
  {
    freq: '81.4',
    sound: null,
    src: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_one',
    title: 'BBC Radio 1',
  },
  {
    freq: '89.9',
    sound: null,
    src: 'https://streaming.radio.co/s97881c7e0/listen',
    title: 'Hip Hop Hits',
  },
  {
    freq: '98.9',
    sound: null,
    src: 'https://tunein.streamguys1.com/cnn-new',
    title: 'CNN',
  },
  {
    freq: '103.3',
    sound: null,
    src: 'https://rfcmedia.streamguys1.com/80hits.mp3',
    title: "80's Hits",
  },
  {
    freq: '107.7',
    sound: null,
    src: 'https://rfcmedia.streamguys1.com/MusicPulse.mp3',
    title: "Today's Hits",
  },
]);
