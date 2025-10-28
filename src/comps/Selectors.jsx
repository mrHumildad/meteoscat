import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDroplet, faSeedling, faTemperatureLow, faCalendarDays, faRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
const Selectors = ({ daysRange, handleSelect, minDate, maxDate, setSelectedVariable, showCalendar, setShowCalendar }) => {
  return (
    <div className="selectors">
      {showCalendar && <DayPicker
        mode="range"
        selected={daysRange}
        onSelect={handleSelect}
        showOutsideDays
        modifiers={{ start: daysRange?.from, end: daysRange?.to }}
        disabled={(date) => date < minDate || date > maxDate}
      />} 
      <div className="sel-buttons">
        <div className='sel-button temp' onClick={() => setSelectedVariable('tempAvg')}><FontAwesomeIcon icon={faTemperatureLow} /></div>
        <div className='sel-button rain' onClick={() => setSelectedVariable('precAcc')}> <FontAwesomeIcon icon={faDroplet} /></div>
        <div className='sel-button humidity' onClick={() => setSelectedVariable('humAvg')}><FontAwesomeIcon icon={faSeedling} /></div>
        <div className='sel-button calendar' onClick={() => setShowCalendar(!showCalendar)}>
          {!showCalendar ? <FontAwesomeIcon icon={faCalendarDays} /> : <FontAwesomeIcon icon={faRightFromBracket} />}
        </div>
      </div>
    </div>
  );
};

export default Selectors;
