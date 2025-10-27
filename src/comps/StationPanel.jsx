import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts';
import { fmt } from '../logic/utils.js';
const StationPanel = ({ station, setSelectedStation, data, daysRange }) => {

  if (!station) {
    return (
      <div className="station-panel">
        <p>Feu clic a una estació al mapa per veure detalls.</p>
      </div>
    );
  }

  const chartData = useMemo(() => {
    if (!data || !station?.properties?.codi) return [];

    const from = daysRange?.from ? new Date(daysRange.from) : null;
    const to = daysRange?.to ? new Date(daysRange.to) : from;

    // generate all dates in range
    const allDates = [];
    if (from && to) {
      const d = new Date(from);
      while (d <= to) {
        allDates.push(fmt(d)); // using your fmt function
        d.setDate(d.getDate() + 1);
      }
    }

    // fill chart data, missing days get 0
    const chart = allDates.map(day => ({
      day,
      precAcc: data[day]?.[station.properties.codi]?.precAcc ?? 0
    }));

    return chart;
  }, [data, station, daysRange]);

  // find top 3 non-zero values
  const topValues = useMemo(() => {
    return chartData
      .map(d => d.precAcc)
      .filter(v => v > 0)
      .sort((a, b) => b - a)
      .slice(0, 3);
  }, [chartData]);

  return (
    <div className="station-panel">
      <h3>{station.properties?.nom || station.properties?.codi}</h3>
      <p>{station.properties?.comarca}</p>
      <p>Temperatura mitjana: {station.properties?.tempAvg ?? 'N/A'} °C</p>
      <p>Humitat mitjana: {station.properties?.humAvg ?? 'N/A'} %</p>
      <p>Precipitació acumulada: {station.properties?.precAcc ?? 'N/A'} mm</p>

      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis />
            <Tooltip />
            <Bar dataKey="precAcc" fill="#8884d8">
              <LabelList 
                dataKey="precAcc" 
                position="top" 
                formatter={(val) => topValues.includes(val) && val > 0 ? val : ''} 
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <button onClick={() => setSelectedStation(null)}>Tancar</button>
    </div>
  );
};

export default StationPanel;
