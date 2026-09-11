import React, { useMemo, useState } from 'react';
import { fmt, fmtNum } from '../logic/utils.js';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCarrot, faDroplet, faSeedling, faTemperatureLow, faRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { fmtDayCat } from '../logic/utils.js';
import { SPECIES } from '../logic/speciesRules.js';

const StationPanel = ({ station, setSelectedStation, data, daysRange, elevation, boletFilter, boletScores, stationDayRange }) => {
  const [isOpen, setIsOpen] = useState(true);

  // global min/max from dayStats (hooks must run before the early return)
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

  // generate day data — each day also carries its offset back from the
  // reference day (daysRange.to = last data day) so the bar can be flagged
  // as inside its variable's stationDayRange (the window the circle values
  // are aggregated over). The chart itself stays fixed (daysRange); only the
  // highlight follows the filters.
  const chartData = useMemo(() => {
    if (!data || !station?.properties?.codi) return [];

    const from = daysRange?.from ? new Date(daysRange.from) : null;
    const to = daysRange?.to ? new Date(daysRange.to) : from;
    const refTime = to ? new Date(to).getTime() : null;

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

    // a day is inside a range when its offset (days back from the reference
    // day) falls between the range's `to` (nearest) and `from` (farthest)
    const inRange = (r, offset) =>
      r != null && offset != null && offset >= r.to && offset <= r.from;

    return allDates.map(day => {
      const offset = refTime != null
        ? Math.round((refTime - new Date(day).getTime()) / 86400000)
        : null;
      return {
        day,
        offset,
        rainIn: inRange(stationDayRange?.rain, offset),
        humIn: inRange(stationDayRange?.hum, offset),
        tempIn: inRange(stationDayRange?.temp, offset),
        precAcc: data[day]?.[station.properties.codi]?.precAcc ?? 0,
        humAvg: data[day]?.[station.properties.codi]?.humAvg ?? 0,
        tempAvg: data[day]?.[station.properties.codi]?.tempAvg ?? 0
      };
    });
  }, [data, station, daysRange, stationDayRange]);

  if (!station) {
    return (
      <div className="station-panel">
        <p>Feu clic a una estació al mapa per veure detalls.</p>
      </div>
    );
  }

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
        <span
          className="st-altitud"
          title={
            elevation != null
              ? `Altitud del terreny al punt (DEM) · altitud de l'estació: ${station.properties?.altitud ?? '—'} m`
              : "Altitud de l'estació (metadades Meteocat)"
          }
        >
          {elevation != null ? elevation : station.properties?.altitud ?? '—'} m
        </span>
        <span className="st-comarca">{station.properties?.comarca}</span>
      </div>
      <div className="st-block">
        <div className="block-left">
          <span className="st-block-icon">
            <FontAwesomeIcon icon={faDroplet} />
          </span>
          <span className="st-block-value">
            TOT {fmtNum(station.properties?.precAcc ?? null, 1) || "N/A"} mm
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className={`bar rain${d.rainIn ? ' hl' : ''}`}
                style={{
                  '--bar-h': `${
                    ((d.precAcc - globalStats.precMin) /
                      (globalStats.precMax - globalStats.precMin || 1)) *
                    100
                  }%`,
                }}
                title={`${d.day}: ${fmtNum(d.precAcc, 1)} mm${d.rainIn ? ' · en el període' : ''}`}
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
            MITJANA {fmtNum(station.properties?.humAvg ?? null, 0) || "N/A"} %
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className={`bar humidity${d.humIn ? ' hl' : ''}`}
                style={{
                  '--bar-h': `${((d.humAvg - globalStats.humMin) /
                    (globalStats.humMax - globalStats.humMin || 1)) * 100}%`,
                }}
                title={`${d.day}: ${fmtNum(d.humAvg, 0)}%${d.humIn ? ' · en el període' : ''}`}
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
            MITJANA {fmtNum(station.properties?.tempAvg ?? null, 1) || "N/A"} °C
          </span>
        </div>
        <div className="block-right">
          <div className="bars horizontal">
            {chartData.map((d, i) => (
              <div
                key={i}
                className={`bar temp${d.tempIn ? ' hl' : ''}`}
                style={{
                  '--bar-h': `${
                    ((d.tempAvg - globalStats.tempMin) /
                      (globalStats.tempMax - globalStats.tempMin || 1)) *
                    100
                  }%`,
                }}
                title={`${d.day}: ${fmtNum(d.tempAvg, 1)} °C${d.tempIn ? ' · en el període' : ''}`}
              />
            ))}
          </div>
        </div>
      </div>
      {boletFilter && (
        <div className="st-block bolet">
          <div className="block-left">
            <span className="st-block-icon">
              <FontAwesomeIcon icon={faCarrot} />
            </span>
            <span className="st-block-value">
              {SPECIES[boletFilter.species]?.name ?? boletFilter.species}:{' '}
              {fmtScore(boletScores, station.properties?.codi)}
            </span>
          </div>
          <div className="block-right">
            {scoreDetail(boletScores, station.properties?.codi)}
          </div>
        </div>
      )}
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

// Show the bolet score for a station code as a whole percentage, or '—'.
const fmtScore = (boletScores, code) => {
  const s = boletScores?.find(x => x.code === code);
  if (s?.score == null) return '—';
  return `${Math.round(s.score * 100)} %`;
};

// Compact trigger detail under the score (rain window / temp / flush lag).
const scoreDetail = (boletScores, code) => {
  const s = boletScores?.find(x => x.code === code);
  if (!s?.stats) return null;
  const { rainTotalMm, tempMeanC, daysSinceBigRain } = s.stats;
  const bits = [];
  if (rainTotalMm != null) bits.push(`${fmtNum(rainTotalMm, 0)} mm`);
  if (tempMeanC != null) bits.push(`${fmtNum(tempMeanC, 1)} °C`);
  if (daysSinceBigRain != null) bits.push(`pluja forta fa ${daysSinceBigRain} d`);
  return bits.length ? (
    <span className="st-block-sub">{bits.join(' · ')}</span>
  ) : null;
};

export default StationPanel;
