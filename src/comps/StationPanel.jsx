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
  // global min/max from dayStats
  const globalStats = useMemo(() => {
    const validDays = Object.values(data || {}).filter(d => d.dayStats);
    const precMax = Math.max(...validDays.map(d => d.dayStats.precMax ?? 0), 0);
    const precMin = Math.min(...validDays.map(d => d.dayStats.precMin ?? 0), 0);
    const humMax = Math.max(...validDays.map(d => d.dayStats.humMax ?? 0), 0);
    const humMin = Math.min(...validDays.map(d => d.dayStats.humMin ?? 0), 0);
    const tempMax = Math.max(...validDays.map(d => d.dayStats.tempMax ?? -100), -100);
    const tempMin = Math.min(...validDays.map(d => d.dayStats.tempMin ?? 100), 100);
    return { precMin, precMax, humMin, humMax, tempMin, tempMax };
  }, [data]);
  console.log(daysRange)
  // generate day data
  const chartData = useMemo(() => {
    if (!data || !station?.properties?.codi) return [];

    const from = daysRange?.from ? new Date(daysRange.from) : null;
    const to = daysRange?.to ? new Date(daysRange.to) : from;

    const allDates = [];
    if (from && to) {
      // normalize to midnight to avoid timezone/time-of-day issues
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      const end = new Date(to);
      end.setHours(0, 0, 0, 0);
      while (d <= end) {
        allDates.push(fmt(new Date(d)));
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
  //const maxRain = Math.max(...chartData.map(d => d.precAcc), 0);
  //const maxHum = Math.max(...chartData.map(d => d.humAvg), 0);
  //const maxTemp = Math.max(...chartData.map(d => d.tempAvg), -100);
  //console.log(maxRain, maxHum, maxTemp);
  //console.log(chartData);
  return (
    <div className={`station-panel ${isOpen ? "open" : "closed"}`}>
      <div
        className="station-close"
        onClick={() => {
          setSelectedStation(null);
          setIsOpen(false);
        }}
      >
        <FontAwesomeIcon icon={faRightFromBracket} />
      </div>
      <div className="st-header">
        <span className="st-name">
          {station.properties?.nom.toUpperCase() || station.properties?.codi}
        </span>
        <span className="st-altitud">{station.properties?.altitud} m</span>
        <span className="st-comarca">{station.properties?.comarca}</span>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon">
            <FontAwesomeIcon icon={faDroplet} />
          </span>
          <span className="st-block-value">
            TOT {station.properties?.precAcc ?? "N/A"} mm
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className="bar rain"
                style={{
                  height: `${
                    ((d.precAcc - globalStats.precMin) /
                      (globalStats.precMax - globalStats.precMin || 1)) *
                    100
                  }%`,
                }}
                title={`${d.day}: ${d.precAcc} mm`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon">
            <FontAwesomeIcon icon={faSeedling} />
          </span>
          <span className="st-block-value">
            MITJANA {station.properties?.humAvg ?? "N/A"} %
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className="bar humidity"
                style={{
                  height: `${((d.humAvg - globalStats.humMin) /
                    (globalStats.humMax - globalStats.humMin || 1)) * 100}%`
                }}
                title={`${d.day}: ${d.humAvg}%`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon">
            <FontAwesomeIcon icon={faTemperatureLow} />
          </span>
          <span className="st-block-value">
            MITJANA {station.properties?.tempAvg ?? "N/A"} °C
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className="bar temp"
                style={{ height: `${
      ((d.tempAvg - globalStats.tempMin) /
        (globalStats.tempMax - globalStats.tempMin || 1)) * 100
    }%` }}
                title={`${d.day}: ${d.tempAvg} °C`}
              />
            ))}
          </div>
        </div>
      </div>
      <div id="st-days" className="bars horizontal">
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
