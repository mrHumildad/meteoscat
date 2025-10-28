import React, { useMemo, useState } from 'react';
import { fmt } from '../logic/utils.js';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDroplet, faSeedling, faTemperatureLow, faRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { fmtDayCat } from '../logic/utils.js';

const StationPanel = ({ station, setSelectedStation, data, daysRange }) => {
   const [isOpen, setIsOpen] = useState(true);
  if (!station) {
    return (
      <div className="station-panel">
        <p>Feu clic a una estació al mapa per veure detalls.</p>
      </div>
    );
  }

  // generate day data
  const chartData = useMemo(() => {
    if (!data || !station?.properties?.codi) return [];

    const from = daysRange?.from ? new Date(daysRange.from) : null;
    const to = daysRange?.to ? new Date(daysRange.to) : from;

    const allDates = [];
    if (from && to) {
      const d = new Date(from);
      while (d <= to) {
        allDates.push(fmt(d));
        d.setDate(d.getDate() + 1);
      }
    }

    return allDates.map(day => ({
      day,
      precAcc: data[day]?.[station.properties.codi]?.precAcc ?? 0,
      humAvg: data[day]?.[station.properties.codi]?.humAvg ?? 0,
      tempAvg: data[day]?.[station.properties.codi]?.tempAvg ?? 0
    }));
  }, [data, station, daysRange]);

  // max values for scaling
  const maxRain = Math.max(...chartData.map(d => d.precAcc), 0);
  const maxHum = Math.max(...chartData.map(d => d.humAvg), 0);
  const maxTemp = Math.max(...chartData.map(d => d.tempAvg), -100);
  console.log(maxRain, maxHum, maxTemp);
  console.log(chartData);
  return (
    <div className={`station-panel ${isOpen ? "open" : "closed"}`}>
      <div className="station-close" onClick={() => {setSelectedStation(null); setIsOpen(false);}}>
        <FontAwesomeIcon icon={faRightFromBracket} />
      </div>
      <div className="st-header">
        <span className='st-name'>{station.properties?.nom.toUpperCase() || station.properties?.codi}</span>
        <span className='st-altitud'>{station.properties?.altitud} m</span>
        <span className='st-comarca'>{station.properties?.comarca}</span>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon"><FontAwesomeIcon icon={faDroplet} /></span>
          <span className="st-block-value">TOT {station.properties?.precAcc ?? 'N/A'} mm</span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div key={i} className="bar rain" 
                style={{ height: `${(d.precAcc / maxRain) * 100}%` }}
                title={`${d.day}: ${d.precAcc} mm`} />
            ))}
          </div>
        </div>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon"><FontAwesomeIcon icon={faSeedling} /></span>
          <span className="st-block-value">MITJANA {station.properties?.humAvg ?? 'N/A'} %</span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div key={i} className="bar humidity"
                style={{ height: `${(d.humAvg / maxHum) * 100}%` }}
                title={`${d.day}: ${d.humAvg}%`} />
            ))}
          </div>
        </div>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon"><FontAwesomeIcon icon={faTemperatureLow} /></span>
          <span className="st-block-value">MITJANA {station.properties?.tempAvg ?? 'N/A'} °C</span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div key={i} className="bar temp"
                style={{ height: `${(d.tempAvg / maxTemp) * 100}%` }}
                title={`${d.day}: ${d.tempAvg} °C`} />
            ))}
          </div>
        </div>
      </div>
      <div id="st-days" className="bars horizontal" >
        {chartData.map((d, i) => (
          <div key={i} className="bar day">
            {fmtDayCat(d.day)}
          </div>
        ))}
      </div>
    </div>
  );
};

export default StationPanel;
