import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
const Selectors = ({daysRange, handleSelect, minDate, maxDate, setSelectedVariable}) => {
  return (
    <div>
      <DayPicker
        mode="range"
        selected={daysRange}
        onSelect={handleSelect}
        showOutsideDays
        modifiers={{ start: daysRange?.from, end: daysRange?.to }}
        disabled={{ before: minDate, after: maxDate }}
      />
      <div >
        <button onClick={() => setSelectedVariable('tempAvg')}>Temperatura</button>
        <button onClick={() => setSelectedVariable('precAcc')}>Precipitació</button>
        <button onClick={() => setSelectedVariable('humAvg')}>Humitat</button>
      </div>
    </div>
  );
}

export default Selectors;
