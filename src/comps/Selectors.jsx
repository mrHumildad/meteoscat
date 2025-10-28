import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDroplet, faSeedling, faTemperatureLow, faCalendarDays } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
const Selectors = ({ daysRange, handleSelect, minDate, maxDate, setSelectedVariable }) => {
  const [showCalendar, setShowCalendar] = useState(false);
  return (
    <div className="selectors">
      <div className="buttons">
        <div onClick={() => setSelectedVariable('tempAvg')}><FontAwesomeIcon icon={faTemperatureLow} /></div>
        <div onClick={() => setSelectedVariable('precAcc')}> <FontAwesomeIcon icon={faDroplet} /></div>
        <div onClick={() => setSelectedVariable('humAvg')}><FontAwesomeIcon icon={faSeedling} /></div>
        <div onClick={() => setShowCalendar(!showCalendar)}><FontAwesomeIcon icon={faCalendarDays} /></div>
      </div>
      {showCalendar && <DayPicker
        mode="range"
        selected={daysRange}
        onSelect={handleSelect}
        showOutsideDays
        modifiers={{ start: daysRange?.from, end: daysRange?.to }}
        disabled={{ before: minDate, after: maxDate }}
      />} 
    </div>
  );
};

export default Selectors;
