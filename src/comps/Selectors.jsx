import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDroplet, faSeedling, faTemperatureLow, faCalendarDays, faRightFromBracket, faRulerVertical } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect } from 'react';
import RangeSlider from 'react-range-slider-input';
import { filterStationCodes } from '../logic/filterStations.js';
//import 'react-range-slider-input/dist/style.css';
import './rangesliders.css';
const Selectors = ({
  stations, // <== pass full station list here
  setFilteredStationsCodes,
  rangeLimits,
  daysRange,
  handleSelect,
  minDate,
  maxDate,
  setLabelMode,
  showCalendar,
  setShowCalendar,
  setAltBand
}) => {
  // Local state for each range
  const [rainRange, setRainRange] = useState([rangeLimits.rainMin, rangeLimits.rainMax]);
  const [humRange, setHumRange] = useState([rangeLimits.humMin, rangeLimits.humMax]);
  const [tempRange, setTempRange] = useState([rangeLimits.tempMin, rangeLimits.tempMax]);
  const [altRange, setAltRange] = useState([rangeLimits.altMin, rangeLimits.altMax]);

  // Whenever a slider moves → filter stations (pure logic in filterStations.js).
  // An empty code list means "show everything" (e.g. full-range sliders).
  // The altitude band is also pushed up so App can draw the area overlay.
  useEffect(() => {
    setAltBand?.(altRange);
    setFilteredStationsCodes(
      filterStationCodes(stations, rainRange, humRange, tempRange, altRange, rangeLimits)
    );
  }, [rainRange, humRange, tempRange, altRange, stations, rangeLimits, setFilteredStationsCodes, setAltBand]);

  return (
    <div className="selectors">
      {showCalendar && (
        <DayPicker
          mode="range"
          selected={daysRange}
          onSelect={handleSelect}
          showOutsideDays
          disabled={(date) => date < minDate || date > maxDate}
        />
      )}

      <div className="sel-buttons">
        <div className="sel-block">
          <div className="range-container">
            <span className="range-value">{rainRange[0]} mm - {rainRange[1]} mm</span>
          <RangeSlider
            min={rangeLimits.rainMin}
            max={rangeLimits.rainMax}
            step={0.1}
            value={rainRange}
            onInput={setRainRange}
            />
            </div>
          <div
            className="sel-button rain"
            onClick={() => setLabelMode('precAcc')}
          >
            <FontAwesomeIcon icon={faDroplet} />
          </div>
        </div>

        <div className="sel-block">
          <div className="range-container">
            <span className="range-value">{humRange[0]} - {humRange[1]} %</span>
            <RangeSlider
            min={rangeLimits.humMin}
            max={rangeLimits.humMax}
            step={0.1}
            value={humRange}
            onInput={setHumRange}
            />
            </div>
          <div
            className="sel-button humidity"
            onClick={() => setLabelMode('humAvg')}
          >
            <FontAwesomeIcon icon={faSeedling} />
          </div>
        </div>

        <div className="sel-block">
          <div className="range-container">
            <span className="range-value">{tempRange[0]} - {tempRange[1]}</span>
          <RangeSlider
            min={rangeLimits.tempMin}
            max={rangeLimits.tempMax}
            step={0.1}
            value={tempRange}
            onInput={setTempRange}
            />
            </div>
          <div
            className="sel-button temp"
            onClick={() => setLabelMode('tempAvg')}
          >
            <FontAwesomeIcon icon={faTemperatureLow} />
          </div>
        </div>

        <div className="sel-block">
          <div className="range-container">
            <span className="range-value">{altRange[0]} - {altRange[1]} m</span>
            <RangeSlider
              min={rangeLimits.altMin}
              max={rangeLimits.altMax}
              step={10}
              value={altRange}
              onInput={setAltRange}
            />
            </div>
          <div
            className="sel-button altitude"
            onClick={() => setLabelMode('altitud')}
          >
            <FontAwesomeIcon icon={faRulerVertical} />
          </div>
        </div>

        {/* Calendar toggle */}
        <div
          className="sel-button calendar"
          onClick={() => setShowCalendar(!showCalendar)}
        >
          {!showCalendar ? (
            <FontAwesomeIcon icon={faCalendarDays} />
          ) : (
            <FontAwesomeIcon icon={faRightFromBracket} />
          )}
        </div>
      </div>
    </div>
  );
};

export default Selectors;
