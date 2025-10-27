import { useState } from 'react'
import Header from './components/Header.jsx'
import Footer from './components/Footer.jsx'
import OneDay from './components/OneDay.jsx'
import AllDays from './components/AllDays.jsx'
import Map from './components/MapLibre.jsx'
import Filter from './components/Filter.jsx'
import { refineData } from './logic/refineData.js'
//import data from '../full_dades.json'
import './App.css'

const data = refineData()

function App() {
  const [tab, setTab] = useState("map")
  return (
    <div className="App">
      {/* <Header tab={tab} setTab={setTab}/> */}
        <div className="tabs">
          {tab === "oneday" && <OneDay data={data}/>}
          {tab === "alldays" && <AllDays data={data}/>}
          {tab === "filter" && <Filter data={data}/>}
          {tab === "map" && <Map data={data}/>}
        </div>
      <Footer />
    </div>
  )
}

export default App
