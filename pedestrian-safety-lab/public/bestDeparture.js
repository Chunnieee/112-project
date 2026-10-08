// public/bestDeparture.js

(() => {

  const $ =
    (id) =>
      document.getElementById(id);


  const state = {

    start:
      null,

    end:
      null,

    startMarker:
      null,

    endMarker:
      null,

    routeLayer:
      null,

  };


  const els = {

    startInput:
      $("departureStart"),

    endInput:
      $("departureEnd"),

    startSearch:
      $("departureStartSearch"),

    endSearch:
      $("departureEndSearch"),

    startMic:
      $("departureStartMic"),

    endMic:
      $("departureEndMic"),

    startStatus:
      $("departureStartStatus"),

    endStatus:
      $("departureEndStatus"),

    startResults:
      $("departureStartResults"),

    endResults:
      $("departureEndResults"),

    arrival:
      $("desiredArrivalTime"),

    buffer:
      $("arrivalBufferMinutes"),

    mode:
      $("departureTravelMode"),

    button:
      $("runDepartureBtn"),

    result:
      $("departureResult"),

  };


  if (!els.button) {
    return;
  }


  // ======================================================
  // Map hint
  // ======================================================

  const departureTabButton =
    document.querySelector(
      '.tabBtn[data-tab="departure"]'
    );


  if (
    departureTabButton
  ) {

    departureTabButton
      .addEventListener(

        "click",

        () => {

          const hint =
            document.getElementById(
              "mapHint"
            );


          if (hint) {

            hint.textContent =

              "最佳出發時間：輸入起點、終點與希望抵達時間";

          }

        }

      );

  }


  // ======================================================
  // Helpers
  // ======================================================

  function escapeHtml(
    text
  ) {

    return String(
      text ?? ""
    ).replace(

      /[&<>"']/g,

      (char) => ({

        "&":
          "&amp;",

        "<":
          "&lt;",

        ">":
          "&gt;",

        '"':
          "&quot;",

        "'":
          "&#39;",

      }[char])

    );

  }


  function fmtTime(
    timeMs
  ) {

    if (
      !Number.isFinite(
        Number(timeMs)
      )
    ) {

      return "-";

    }


    return new Intl
      .DateTimeFormat(

        "zh-TW",

        {

          month:
            "numeric",

          day:
            "numeric",

          hour:
            "2-digit",

          minute:
            "2-digit",

          hour12:
            false,

        }

      )
      .format(

        new Date(
          Number(timeMs)
        )

      );

  }


  function fmtClock(
    timeMs
  ) {

    if (
      !Number.isFinite(
        Number(timeMs)
      )
    ) {

      return "-";

    }


    return new Intl
      .DateTimeFormat(

        "zh-TW",

        {

          hour:
            "2-digit",

          minute:
            "2-digit",

          hour12:
            false,

        }

      )
      .format(

        new Date(
          Number(timeMs)
        )

      );

  }


  function fmtMinutes(
    seconds
  ) {

    if (
      !Number.isFinite(
        Number(seconds)
      )
    ) {

      return "-";

    }


    return (

      Math.round(
        Number(seconds) /
        60
      ) +

      " 分"

    );

  }


  function toDatetimeLocalValue(
    date
  ) {

    const pad =
      (number) =>
        String(number)
          .padStart(
            2,
            "0"
          );


    return (

      date.getFullYear() +

      "-" +

      pad(
        date.getMonth() + 1
      ) +

      "-" +

      pad(
        date.getDate()
      ) +

      "T" +

      pad(
        date.getHours()
      ) +

      ":" +

      pad(
        date.getMinutes()
      )

    );

  }


  // ======================================================
  // Default arrival time
  //
  // Now + 90 minutes
  // ======================================================

  function setDefaultArrival() {

    if (
      els.arrival.value
    ) {

      return;

    }


    const date =
      new Date(

        Date.now() +

        90 *
        60 *
        1000

      );


    date.setSeconds(
      0,
      0
    );


    date.setMinutes(

      Math.ceil(

        date.getMinutes() /
        10

      ) *

      10

    );


    els.arrival.value =
      toDatetimeLocalValue(
        date
      );


    els.arrival.min =
      toDatetimeLocalValue(

        new Date(

          Date.now() +

          15 *
          60 *
          1000

        )

      );

  }


  setDefaultArrival();


  // ======================================================
  // Parse lat,lon
  // ======================================================

  function parseLatLon(
    text
  ) {

    const match =
      String(
        text || ""
      )
        .trim()
        .match(

          /^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/

        );


    if (!match) {
      return null;
    }


    const lat =
      Number(
        match[1]
      );


    const lon =
      Number(
        match[2]
      );


    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {

      return null;

    }


    return {

      lat,

      lon,

      name:
        text,

      label:
        "座標",

      source:
        "coordinates",

    };

  }


  // ======================================================
  // Place search UI
  // ======================================================

  function setStatus(

    kind,

    text,

    type = ""

  ) {

    const element =

      kind === "start"

        ?

      els.startStatus

        :

      els.endStatus;


    element.textContent =
      text;


    element.className =

      "departurePlaceStatus" +

      (
        type
          ?
        " " + type
          :
        ""
      );

  }


  function clearResults(
    kind
  ) {

    const list =

      kind === "start"

        ?

      els.startResults

        :

      els.endResults;


    list.innerHTML =
      "";


    list.classList
      .remove(
        "open"
      );

  }


  function markerFor(
    kind
  ) {

    return (

      kind === "start"

        ?

      state.startMarker

        :

      state.endMarker

    );

  }


  function setMarker(

    kind,

    marker

  ) {

    if (
      kind === "start"
    ) {

      state.startMarker =
        marker;

    } else {

      state.endMarker =
        marker;

    }

  }


  function setPlace(

    kind,

    place,

    {
      pan = true
    } = {}

  ) {

    const lat =
      Number(
        place.lat
      );


    const lon =
      Number(
        place.lon
      );


    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {

      return;

    }


    const oldMarker =
      markerFor(
        kind
      );


    if (oldMarker) {

      map.removeLayer(
        oldMarker
      );

    }


    const marker =
      L.marker(

        [
          lat,
          lon
        ],

        {

          title:

            kind === "start"

              ?

            "最佳時間：起點"

              :

            "最佳時間：終點",

        }

      )
      .addTo(
        map
      );


    setMarker(
      kind,
      marker
    );


    const normalized = {

      lat,

      lon,

      label:

        place.label ||

        place.name ||

        `${lat},${lon}`,

    };


    state[kind] =
      normalized;


    setStatus(

      kind,

      `✓ ${normalized.label} (${lat.toFixed(5)}, ${lon.toFixed(5)})`,

      "ok"

    );


    clearResults(
      kind
    );


    if (!pan) {
      return;
    }


    if (
      state.start &&
      state.end
    ) {

      map.fitBounds(

        [

          [
            state.start.lat,
            state.start.lon
          ],

          [
            state.end.lat,
            state.end.lon
          ],

        ],

        {
          padding:
            [60, 60]
        }

      );

    } else {

      map.setView(

        [
          lat,
          lon
        ],

        Math.max(
          map.getZoom(),
          15
        )

      );

    }

  }


  function clearResolved(
    kind
  ) {

    state[kind] =
      null;


    const marker =
      markerFor(
        kind
      );


    if (marker) {

      map.removeLayer(
        marker
      );

    }


    setMarker(
      kind,
      null
    );


    setStatus(
      kind,
      ""
    );


    clearResults(
      kind
    );

  }


  // ======================================================
  // Render geocode candidates
  // ======================================================

  function renderSearchResults(

    kind,

    results

  ) {

    const list =

      kind === "start"

        ?

      els.startResults

        :

      els.endResults;


    if (
      !results.length
    ) {

      list.innerHTML =

        "<li class='empty'>" +
        "找不到結果" +
        "</li>";


      list.classList
        .add(
          "open"
        );


      return;

    }


    list.innerHTML =

      results

        .map(

          (
            result,
            index
          ) =>

            `<li data-i="${index}">

              <b>
                ${escapeHtml(
                  result.name ||
                  result.label
                )}
              </b>

              <small>
                ${escapeHtml(
                  result.label ||
                  ""
                )}
              </small>

            </li>`

        )
        .join("");


    list.classList
      .add(
        "open"
      );


    list
      .querySelectorAll(
        "li[data-i]"
      )
      .forEach(

        (item) => {

          item.addEventListener(

            "click",

            () => {

              setPlace(

                kind,

                results[
                  Number(
                    item.dataset.i
                  )
                ]

              );

            }

          );

        }

      );

  }


  // ======================================================
  // Search place
  // ======================================================

  async function searchPlace(

    kind,

    {
      pan = true
    } = {}

  ) {

    const input =

      kind === "start"

        ?

      els.startInput

        :

      els.endInput;


    const query =
      input.value.trim();


    clearResults(
      kind
    );


    if (!query) {

      setStatus(

        kind,

        "請先輸入地點",

        "err"

      );


      return null;

    }


    // ------------------------------------------
    // Direct coordinates
    // ------------------------------------------

    const direct =
      parseLatLon(
        query
      );


    if (direct) {

      setPlace(

        kind,

        direct,

        { pan }

      );


      return state[kind];

    }


    // ------------------------------------------
    // Search API
    // ------------------------------------------

    setStatus(

      kind,

      `搜尋「${query}」中...`

    );


    try {

      const response =
        await fetch(

          "/api/geocode?q=" +

          encodeURIComponent(
            query
          )

        );


      const data =
        await response.json();


      if (

        !response.ok ||

        data.status !== "ok" ||

        !data.results?.length

      ) {

        setStatus(

          kind,

          data.error ||
          "找不到這個地點",

          "err"

        );


        return null;

      }


      setPlace(

        kind,

        data.results[0],

        { pan }

      );


      if (
        data.results.length > 1
      ) {

        renderSearchResults(

          kind,

          data.results

        );

      }


      return state[kind];


    } catch (
      error
    ) {

      setStatus(

        kind,

        "搜尋失敗：" +
        error.message,

        "err"

      );


      return null;

    }

  }


  async function ensurePlace(
    kind
  ) {

    if (
      state[kind]
    ) {

      return state[kind];

    }


    return searchPlace(

      kind,

      {
        pan: false
      }

    );

  }


  // ======================================================
  // Search events
  // ======================================================

  for (
    const kind of
    [
      "start",
      "end"
    ]
  ) {

    const input =

      kind === "start"

        ?

      els.startInput

        :

      els.endInput;


    const button =

      kind === "start"

        ?

      els.startSearch

        :

      els.endSearch;


    input.addEventListener(

      "input",

      () =>
        clearResolved(
          kind
        )

    );


    input.addEventListener(

      "keydown",

      (event) => {

        if (

          event.key === "Enter" &&

          !event.isComposing

        ) {

          event.preventDefault();


          searchPlace(
            kind
          );

        }

      }

    );


    button.addEventListener(

      "click",

      () =>
        searchPlace(
          kind
        )

    );

  }


  // ======================================================
  // Voice input
  // ======================================================

  const SpeechRecognitionImpl =

    window.SpeechRecognition ||

    window.webkitSpeechRecognition;


  function attachMic(

    kind,

    button

  ) {

    if (
      !SpeechRecognitionImpl
    ) {

      button.disabled =
        true;


      button.title =
        "此瀏覽器不支援語音辨識";


      return;

    }


    button.addEventListener(

      "click",

      () => {

        const input =

          kind === "start"

            ?

          els.startInput

            :

          els.endInput;


        const recognition =
          new SpeechRecognitionImpl();


        recognition.lang =
          "zh-TW";


        recognition
          .interimResults =
          false;


        recognition
          .maxAlternatives =
          1;


        button
          .classList
          .add(
            "listening"
          );


        setStatus(

          kind,

          "🎤 請說出地點..."

        );


        recognition.onresult =
          (event) => {

            const text =

              event
                .results?.[0]?.[0]
                ?.transcript
                ?.trim();


            if (text) {

              input.value =
                text.replace(

                  /[。．.!！?？,，\s]+$/,

                  ""

                );

            }

          };


        recognition.onerror =
          (event) => {

            setStatus(

              kind,

              "語音辨識失敗：" +
              event.error,

              "err"

            );

          };


        recognition.onend =
          () => {

            button
              .classList
              .remove(
                "listening"
              );


            clearResolved(
              kind
            );


            if (
              input.value.trim()
            ) {

              searchPlace(
                kind
              );

            }

          };


        recognition.start();

      }

    );

  }


  attachMic(
    "start",
    els.startMic
  );


  attachMic(
    "end",
    els.endMic
  );


  // ======================================================
  // Traffic color
  // ======================================================

  function congestionClass(
    level
  ) {

    if (

      level === "低" ||

      level === "偏低"

    ) {

      return "low";

    }


    if (
      level === "中等"
    ) {

      return "mid";

    }


    return "high";

  }


  // ======================================================
  // Draw candidate route
  // ======================================================

  function drawCandidate(
    candidate
  ) {

    if (
      !candidate?.geometry?.length
    ) {

      return;

    }


    if (
      state.routeLayer
    ) {

      map.removeLayer(
        state.routeLayer
      );

    }


    // 清掉安全功能路線，
    // 避免兩種功能同時疊在地圖上。

    try {

      if (
        typeof clearRouteLayers ===
        "function"
      ) {

        clearRouteLayers();

      }


      if (
        typeof clearComparison ===
        "function"
      ) {

        clearComparison();

      }


      if (
        typeof resultLayer !==
        "undefined"
      ) {

        resultLayer
          .clearLayers();

      }

    } catch {

      // 即使安全功能未來改名，
      // 最佳出發時間仍可使用。

    }


    state.routeLayer =
      L.polyline(

        candidate.geometry,

        {

          color:
            "#7c3aed",

          weight:
            6,

          opacity:
            0.9,

        }

      )
      .addTo(
        map
      );


    map.fitBounds(

      state
        .routeLayer
        .getBounds(),

      {
        padding:
          [55, 55]
      }

    );

  }


  // ======================================================
  // Candidate card
  // ======================================================

  function renderCandidate(

    candidate,

    index,

    recommendedMs

  ) {

    const isRecommended =

      candidate.departureMs ===
      recommendedMs;


    const delayMinutes =
      Math.max(

        0,

        Math.round(

          (
            candidate
              .trafficDelaySeconds ||
            0
          ) /
          60

        )

      );


    const late =
      !candidate.feasible;


    return (

      `<button

        type="button"

        class="
          departureCandidate
          ${
            isRecommended
              ?
            "recommended"
              :
            ""
          }
          ${
            late
              ?
            "late"
              :
            ""
          }
        "

        data-i="${index}"

      >

        <div class="dcTop">

          <b>
            ${fmtClock(
              candidate.departureMs
            )}
            出發
          </b>

          ${
            isRecommended

              ?

            "<span class='recommendPill'>推薦</span>"

              :

            ""
          }

          ${
            late

              ?

            "<span class='latePill'>會太晚</span>"

              :

            ""
          }

        </div>

        <div class="dcMain">

          <span>
            ${fmtMinutes(
              candidate.travelSeconds
            )}
          </span>

          <span>
            →
            ${fmtClock(
              candidate.arrivalMs
            )}
            抵達
          </span>

        </div>

        <div class="dcMeta">

          <span class="
            trafficPill
            ${
              congestionClass(
                candidate
                  .congestionLevel
              )
            }
          ">

            ${
              escapeHtml(
                candidate
                  .trafficPeriod ||
                "-"
              )
            }

            ・壅塞

            ${
              escapeHtml(
                candidate
                  .congestionLevel ||
                "-"
              )
            }

          </span>

          <span>
            交通增加約
            ${delayMinutes}
            分
          </span>

        </div>

      </button>`

    );

  }


  // ======================================================
  // Render recommendation
  // ======================================================

  function renderResult(
    data
  ) {

    // ------------------------------------------
    // Cannot arrive on time
    // ------------------------------------------

    if (
      !data.canArriveOnTime
    ) {

      const earliest =

        [
          ...(
            data.candidates ||
            []
          )
        ]

          .filter(

            (candidate) =>

              Number.isFinite(
                candidate.arrivalMs
              )

          )

          .sort(

            (a, b) =>

              a.arrivalMs -
              b.arrivalMs

          )[0];


      els.result.innerHTML =

        `<div class="departureAlert">

          <b>
            目前分析範圍內找不到能準時抵達的出發時間。
          </b>

          ${
            earliest

              ?

            `<div>
              最早預估抵達：
              ${fmtTime(
                earliest.arrivalMs
              )}
            </div>`

              :

            ""
          }

          <div>
            可以把希望抵達時間往後調，
            或縮短抵達緩衝。
          </div>

        </div>`;


      return;

    }


    // ------------------------------------------
    // Recommendation
    // ------------------------------------------

    const recommended =
      data.recommended;


    const delayMinutes =
      Math.max(

        0,

        Math.round(

          (
            recommended
              .trafficDelaySeconds ||
            0
          ) /
          60

        )

      );


    const windowText =

      recommended.windowStartMs ===
      recommended.windowEndMs

        ?

      fmtClock(
        recommended.windowEndMs
      )

        :

      (
        fmtClock(
          recommended.windowStartMs
        ) +

        "–" +

        fmtClock(
          recommended.windowEndMs
        )
      );


    els.result.innerHTML =

      `<div class="departureHero">

        <div class="dhLabel">
          建議出發時間
        </div>

        <div class="dhTime">
          ${windowText}
        </div>

        <div class="dhGrid">

          <div>

            <small>
              預估車程
            </small>

            <b>
              ${fmtMinutes(
                recommended.travelSeconds
              )}
            </b>

          </div>


          <div>

            <small>
              預估抵達
            </small>

            <b>
              ${fmtClock(
                recommended.arrivalMs
              )}
            </b>

          </div>


          <div>

            <small>
              壅塞程度
            </small>

            <b>
              ${escapeHtml(
                recommended
                  .congestionLevel
              )}
            </b>

          </div>


          <div>

            <small>
              交通增加
            </small>

            <b>
              約 ${delayMinutes} 分
            </b>

          </div>

        </div>


        <div class="dhSource">

          ${escapeHtml(
            data.dataSource
          )}

          ・

          ${escapeHtml(
            recommended
              .trafficPeriod
          )}

        </div>

      </div>` +


      `<div class="departureWhy">

        <h4>
          為什麼推薦這個時間？
        </h4>

        <ul>

          ${
            (
              data.explanation ||
              []
            )
              .map(

                (line) =>

                  `<li>
                    ${escapeHtml(
                      line
                    )}
                  </li>`

              )
              .join("")
          }

        </ul>

      </div>` +


      `<h4>
        不同出發時間比較
      </h4>` +


      `<div class="departureCandidates">

        ${
          (
            data.candidates ||
            []
          )
            .map(

              (
                candidate,
                index
              ) =>

                renderCandidate(

                  candidate,

                  index,

                  recommended
                    .departureMs

                )

            )
            .join("")
        }

      </div>` +


      `<div class="departureMethod">

        推薦方式：
        先排除會遲到的時間，
        再找車程接近最短的候選，
        最後選擇其中較晚出發的時段。
        因此不是「越早越好」。

      </div>`;


    // ------------------------------------------
    // Click candidate
    // ------------------------------------------

    els.result
      .querySelectorAll(
        ".departureCandidate"
      )
      .forEach(

        (button) => {

          button.addEventListener(

            "click",

            () => {

              const candidate =

                data.candidates[

                  Number(
                    button.dataset.i
                  )

                ];


              drawCandidate(
                candidate
              );

            }

          );

        }

      );


    // Draw recommended route automatically

    drawCandidate(
      recommended
    );

  }


  // ======================================================
  // Run recommendation
  // ======================================================

  els.button
    .addEventListener(

      "click",

      async () => {

        els.result.innerHTML =

          "<div class='loadingBox'>" +

          "正在解析地點並比較不同出發時間，可能需要幾秒..." +

          "</div>";


        // ----------------------------------------
        // Resolve start/end
        // ----------------------------------------

        const [
          start,
          end
        ] =

          await Promise.all([

            ensurePlace(
              "start"
            ),

            ensurePlace(
              "end"
            ),

          ]);


        if (
          !start ||
          !end
        ) {

          els.result.innerHTML =

            "<div class='errorBox'>" +

            "請先確認起點和終點都能成功找到。" +

            "</div>";


          return;

        }


        // ----------------------------------------
        // Arrival time
        // ----------------------------------------

        const targetArrivalMs =

          new Date(
            els.arrival.value
          ).getTime();


        if (
          !Number.isFinite(
            targetArrivalMs
          )
        ) {

          els.result.innerHTML =

            "<div class='errorBox'>" +

            "請設定希望抵達的日期與時間。" +

            "</div>";


          return;

        }


        if (

          targetArrivalMs <=

          Date.now() +

          10 *
          60 *
          1000

        ) {

          els.result.innerHTML =

            "<div class='errorBox'>" +

            "希望抵達時間太接近現在，請選擇更晚的時間。" +

            "</div>";


          return;

        }


        // ----------------------------------------
        // UI loading state
        // ----------------------------------------

        els.button.disabled =
          true;


        els.button.textContent =
          "分析中...";


        try {

          const params =
            new URLSearchParams({

              startLat:
                String(
                  start.lat
                ),

              startLon:
                String(
                  start.lon
                ),

              endLat:
                String(
                  end.lat
                ),

              endLon:
                String(
                  end.lon
                ),

              targetArrivalMs:
                String(
                  targetArrivalMs
                ),

              arrivalBufferMinutes:
                String(
                  Number(
                    els.buffer.value
                  ) || 0
                ),

              travelMode:
                els.mode.value,

              intervalMinutes:
                "15",

              lookbackMinutes:
                "120",

            });


          const response =
            await fetch(

              "/api/best-departure-time?" +

              params.toString()

            );


          const data =
            await response.json();


          if (

            !response.ok ||

            data.status !== "ok"

          ) {

            // 同時顯示摘要和後端回傳的真正原因，
            // 不然只會看到「推薦失敗」而不知道原因。

            const summary =
              data.message ||
              data.error ||
              "推薦失敗";

            const reason =
              data.detail &&
              data.detail !== summary
                ?
                `（原因：${data.detail}）`
                :
                "";

            throw new Error(
              summary + reason
            );

          }


          renderResult(
            data
          );


        } catch (
          error
        ) {

          els.result.innerHTML =

            "<div class='errorBox'>" +

            escapeHtml(
              error.message
            ) +

            "</div>";


        } finally {

          els.button.disabled =
            false;


          els.button.textContent =
            "推薦最佳出發時間";

        }

      }

    );

})();