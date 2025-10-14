import { useState } from 'react'
import Header from './components/Header.jsx'
import Footer from './components/Footer.jsx'
import OneDay from './components/OneDay.jsx'
import AllDays from './components/AllDays.jsx'
import Filter from './components/Filter.jsx'
//import data from '../full_dades.json'
import './App.css'

function App() {
  const [tab, setTab] = useState("filter")
  return (
    <div className="App">
      <Header tab={tab} setTab={setTab}/>
        <div className="tabs">
          {tab === "oneday" && <OneDay />}
          {tab === "alldays" && <AllDays />}
          {tab === "filter" && <Filter />}
        </div>
      <Footer />
    </div>
  )
}

export default App
