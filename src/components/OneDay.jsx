import React from 'react';
import { useState } from 'react'
import stations from '../../stations.json'
import { getAverage } from '../logic/utils'
import { refineData } from '../logic/refineData'
const data = refineData()
const days = Object.keys(data)

const OneDay = () => {
  const [selectedDay, setSelectedDay] = useState(days[0])
    const [valueShowed, setValueShowed] = useState("temperatura")
    const daysButtons= days.map(day => (
      <button key={day} onClick={() => setSelectedDay(day)}>{day}</button>
    ))
  return (
          <div className="stations-sheet">
        {daysButtons}
        <table>
          <thead>
            <tr >
              <th>Estació</th>
              <th><button onClick={() => setValueShowed("temperatura")}>Temperatura</button></th>
              <th><button onClick={() => setValueShowed("humitat")}>Humitat</button></th>
              <th><button onClick={() => setValueShowed("precipitacio")}>Precipitació</button></th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(data[selectedDay]).sort((a, b) => getAverage(data[selectedDay][b][valueShowed]) - getAverage(data[selectedDay][a][valueShowed]))
              .map(station => (
              <tr key={station} >
                <td>{stations.find(s => s.codi === station).nom}</td>
                <td>{getAverage(data[selectedDay][station].temperatura)}</td>
                <td>{getAverage(data[selectedDay][station].humitat)}</td>
                <td>{getAverage(data[selectedDay][station].precipitacio)}</td>
                
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}

export default OneDay;
