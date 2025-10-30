import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDroplet, faSeedling, faTemperatureLow, faCalendarDays, faRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect } from 'react';
import RangeSlider from 'react-range-slider-input';
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
  setSelectedVariable,
  showCalendar,
  setShowCalendar
}) => {
  // Local state for each range
  const [rainRange, setRainRange] = useState([rangeLimits.rainMin, rangeLimits.rainMax]);
  const [humRange, setHumRange] = useState([rangeLimits.humMin, rangeLimits.humMax]);
  const [tempRange, setTempRange] = useState([rangeLimits.tempMin, rangeLimits.tempMax]);

  // Whenever a slider moves → filter stations
  useEffect(() => {
    if (!stations || stations.length === 0) return;

    const filtered = stations.filter(st => {
      const p = st.properties || {};
      const t = Number(p.tempAvg);
      const h = Number(p.humAvg);
      const r = Number(p.precAcc);

      return (
        !isNaN(t) && t >= tempRange[0] && t <= tempRange[1] &&
        !isNaN(h) && h >= humRange[0] && h <= humRange[1] &&
        !isNaN(r) && r >= rainRange[0] && r <= rainRange[1]
      );
    });

    setFilteredStationsCodes(filtered.map(st => st.properties?.code));
  }, [rainRange, humRange, tempRange, stations]);

  return (
    <div className="selectors">
      {showCalendar && (
        <DayPicker
          mode="range"
          selected={daysRange}
          onSelect={handleSelect}
          showOutsideDays
          modifiers={{ start: daysRange?.from, end: daysRange?.to }}
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
            onClick={() => setSelectedVariable('precAcc')}
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
            onClick={() => setSelectedVariable('humAvg')}
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
            onClick={() => setSelectedVariable('tempAvg')}
          >
            <FontAwesomeIcon icon={faTemperatureLow} />
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
