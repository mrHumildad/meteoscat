import React from 'react';

const Header = ({tab, setTab}) => {
  const tabs = ["oneday", "alldays", "filter"]
  const tabIndex = tabs.indexOf(tab)

  return (
    <div className='Header'>
      <h4>MeteoSCat</h4>
      <buttton onClick={() => setTab(tabs[(tabIndex + 2) % tabs.length])}>{"cambia eina"}</buttton>
    </div>
  );
}

export default Header;
