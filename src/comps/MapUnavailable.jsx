/**
 * Shown in place of the map when the browser cannot create a WebGL2 context —
 * MapLibre GL JS v6's only rendering path. Without it the app would sit on a
 * blank map canvas with no explanation of what happened or how to fix it.
 *
 * The copy is Catalan like the rest of the UI, and lists the fixes in the order
 * they resolve the common cases (see WEBGL_FALLBACK_REPORT.md §3): re-enable
 * hardware acceleration, check `brave://gpu`, then opt into software WebGL when
 * the machine has no usable GPU at all.
 *
 * `detail` is the raw failure (MapLibre's statusMessage or error message) and is
 * kept collapsed, so it can be quoted in a bug report without cluttering the
 * notice.
 */
const MapUnavailable = ({ detail }) => (
  <div className="map-unavailable">
    <div className="map-unavailable-card">
      <h2 className="map-unavailable-title">No es pot mostrar el mapa</h2>
      <p className="map-unavailable-text">
        Aquest navegador no pot crear un context <strong>WebGL2</strong>, la
        tecnologia que el mapa necessita per dibuixar-se. Normalment passa quan
        l'acceleració gràfica està desactivada o quan no hi ha cap GPU
        disponible.
      </p>
      <p className="map-unavailable-subtitle">Com ho pots resoldre:</p>
      <ol className="map-unavailable-steps">
        <li>
          Activa l'acceleració gràfica a <em>Configuració → Sistema → «Fes servir
          l'acceleració gràfica quan estigui disponible»</em> i reinicia el
          navegador.
        </li>
        <li>
          Comprova'n l'estat a <code>brave://gpu</code> (o <code>chrome://gpu</code>):
          «WebGL2» ha de dir <em>Hardware accelerated</em>.
        </li>
        <li>
          Si l'equip no té GPU, activa el WebGL per programari a{' '}
          <code>brave://flags/#enable-unsafe-swiftshader</code> (<em>Enabled</em>)
          i reinicia.
        </li>
        <li>Mentrestant, prova-ho amb un altre navegador (per exemple Firefox).</li>
      </ol>
      <p className="map-unavailable-note">
        La resta de l'aplicació continua carregant les dades, però sense mapa no
        es poden consultar les estacions.
      </p>
      {detail && (
        <details className="map-unavailable-details">
          <summary>Detalls tècnics</summary>
          <code>{detail}</code>
        </details>
      )}
    </div>
  </div>
);

export default MapUnavailable;
