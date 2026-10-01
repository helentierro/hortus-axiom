# HORTUS

Un mundo que crece a partir de una semilla y luego deja que la evolución ocurra dentro.

Terreno, ríos, clima y biomas se generan de forma determinista; animales con
genomas y controladores neuronales nacen, comen, cazan, se reproducen y mueren;
y puedes interferir en cualquier momento escribiendo **AXIOM**, un Lisp pequeño que
alcanza dentro de la simulación en marcha.

---

## Cómo abrirlo

**Doble clic en `index.html`.** Ya está.

No hay build, ni dependencias, ni servidor, ni conexión a internet. Es
JavaScript plano en ficheros sueltos, precisamente para que funcione abriendo el
fichero directamente con `file://`. Cualquier navegador moderno sirve —
probado en Chrome y Edge.

Si prefieres servirlo por HTTP (a veces necesario para herramientas de desarrollo):

```bash
node tests/serve.js        # http://localhost:8731
```

**La primera pantalla pide que pulses ENTER THE GARDEN.** A partir de ahí el
mundo corre solo. Hay una pantalla de arranque a propósito: genera el mapa,
puebla la población y compila los shaders antes de enseñarte nada.

---

## Qué hacer con esto

- **Míralo.** Déjalo correr. El reloj va a 8 días por segundo por defecto; el
  deslizador llega a 60. Los gráficos de abajo son población, biomasa y energía.
- **Mira el gráfico de linajes.** Cada raya es una especie, los puntos son récords
  nuevos, y **cada hueco es una extinción**. Vuelve a crecer cuando la especie
  reaparece.
- **Escribe AXIOM.** El botón **RUN** (o `Ctrl`+`Enter`) ejecuta el programa. El
  panel **EXAMPLES** trae nueve programas que ya funcionan: culling selectivo,
 _macera_ de politicasts, olas de tizón, linajes divergentes…
- **Pinta sobre el mapa.** Las herramientas de la barra izquierda manchan tizón,
  flores y terremotos. La simulación reacciona de verdad.
- **Lee el manual.** El botón `?` de la barra superior. Está bien escrito y
  describe lo que el programa hace, no lo que debería hacer.

### Atajos

| Tecla | Acción |
|---|---|
| `Espacio` | pausa / reanuda |
| `Ctrl`+`Enter` | ejecutar el programa AXIOM |
| `Ctrl`+`/` | comentar la línea actual |
| `1` – `6` | modo de vista (terreno, carta, biomasa, térmico, agua, estrés) |
| `F` | encuadrar el mundo entero |
| `M` | silenciar |
| `.` | avanzar un día |
| `?` | manual |
| `Esc` | cerrar el manual, o salir del campo de texto |

El ratón arrastra para mover, la rueda hace zoom. En pantallas táctiles también
funciona arrastrar y pellizcar.

---

## Semillas

Un mundo es reproducible: la misma semilla da exactamente el mismo mapa, el
mismo clima, los mismos genomas y las mismas muertes. Incluye la extinción
final de la especie que perdió.

Sin `?seed=` en la barra de direcciones, cada visita genera una semilla nueva.

- **Para volver a un mundo:** `?seed=orchard` en la barra de direcciones.
- **Para no perder el tuyo:** el botón **🌍** de la barra superior recuerda la
  semilla y la recarga te devuelve al mismo mundo. Está apagado por defecto,
  porque lo bonito de una visita nueva es que sea nueva.
- **Un estado ya vivido no se guarda.** La semilla reproduce el mundo *inicial*
  exactamente, no el punto donde lo dejaste. Eso es deliberado: no hay servidor
  ni base de datos, así que el estado vive en tu memoria y en la semilla.

### Otros parámetros de la URL

| Parámetro | Efecto |
|---|---|
| `?seed=mi-semilla` | mundo concreto |
| `?auto=1` | arranca sin pulsar nada (capturas de pantalla, tests) |
| `?renderer=canvas2d` | fuerza el render por CPU |
| `?set=grain:0,bloom:0` | ajusta el render; útil para depurar y para comparar |

---

## Si va lento o se ve raro

- **Va lento.** Reduce la velocidad, o pulsa `F` para dejar de estar en zoom
  máximo, donde hay muchas criaturas dibujándose.
- **El render por WebGL2 ha fallado.** Verás un aviso ámbar en la esquina
  inferior izquierda del mapa y la simulación sigue funcionando igual, solo que
  con gráficos más toscos. Fuerza la comparación con `?renderer=canvas2d`.
- **La pestaña está en segundo plano.** El navegador frena `requestAnimationFrame`
  y el mundo se congela. Es el navegador, no el programa.
- **No oyes nada.** El audio necesita un primer gesto del usuario; hasta que no
  pulses algo, el navegador no deja crear el contexto de audio.

---

## Cómo está hecho

```
index.html            el shell, y el orden en que se carga todo
css/main.css          sistema visual y layout
js/core/              rng con semilla, ruido, rejilla hexagonal
js/world/             generación del mundo, genomas, cerebro, ecosistema
js/lang/              AXIOM: lector, intérprete, biblioteca estándar
js/render/            shaders GLSL, renderer WebGL2, fallback Canvas2D, paleta
js/audio/             síntesis con osciladores y ruido filtrado
js/ui/                editor, paneles, gráficos, manual
scripts/examples.js   los programas de ejemplo
tests/                pruebas (ver abajo)
```

Ninguna dependencia. Sin paso de compilación. Todo el arte es procedural: no hay
imágenes, ni fuentes, ni sonidos.

---

## Pruebas

```bash
node tests/lang.test.js            # 127 pruebas del lenguaje AXIOM
node tests/world.test.js           # generación, determinismo, invariantes de hexágonos
node tests/eco.test.js orchard 800 # 800 días simulados, estabilidad y determinismo
node tests/dist.debug.js orchard   # histogramas de terreno, clima y biomas
node tests/climate.debug.js        # ciclo estacional: temperatura, nieve, vegetación
```

Las de navegador necesitan un servidor, porque `file://` no carga scripts entre
ficheros de forma fiable:

```bash
node tests/serve.js                # en una terminal
```

Y luego abre `http://localhost:8731/tests/smoke.html`. Son **114** pruebas que
cubren el render WebGL2, el fallback Canvas2D, los paneles, el lenguaje, los
ejemplos, el cableado de la aplicación y el ciclo de vida de los recursos.

`tests/render-compare.html` pone los dos renderers uno al lado del otro, con
canales de depuración y un interruptor por semilla.

> Una nota sobre por qué hay tantos tests del "cableado" y no solo de los módulos:
> cada defecto serio que ha tenido este programa vivía en el pegamento entre
> piezas —el REPL moría en cada envío, el gráfico de linajes nunca se dibujó,
> `boot()` podía arrancar dos veces— y ninguno era alcanzable desde una suite que
> solo ejercitaba los módulos por separado. Por eso `app.js` se expone como
> `HX.App` y hay tests que lo llaman directamente.