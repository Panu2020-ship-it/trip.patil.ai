/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionDeclaration, GoogleGenAI, Type} from '@google/genai';

// Fix: Add TypeScript declarations for the Google Maps API and custom Popup class to resolve type errors.
declare const google: any;
declare global {
  interface Window {
    Popup: any;
  }
}

const {Map} = await google.maps.importLibrary('maps');
const {LatLngBounds} = await google.maps.importLibrary('core');
const {AdvancedMarkerElement} = await google.maps.importLibrary('marker');

// Application state variables
let map; // Holds the Google Map instance
let points = []; // Array to store geographical points from responses
let markers = []; // Array to store map markers
let lines = []; // Array to store polylines representing routes/connections
let popUps = []; // Array to store custom popups for locations
let bounds; // Google Maps LatLngBounds object to fit map around points
let isPlannerMode = false; // Flag to indicate if Day Planner mode is active
let dayPlanItinerary = []; // Array to hold structured items for the day plan timeline
const RECENT_SEARCHES_KEY = 'mapExplorerRecentSearches';
const MAX_RECENT_SEARCHES = 5;
let recentSearches: string[] = [];

// DOM Element references
const generateButton = document.querySelector('#generate') as HTMLButtonElement;
const resetButton = document.querySelector('#reset') as HTMLButtonElement;
const cardContainer = document.querySelector(
  '#card-container',
) as HTMLDivElement;
const plannerModeToggle = document.querySelector(
  '#planner-mode-toggle',
) as HTMLInputElement;
const timelineView = document.querySelector(
  '#timeline-view',
) as HTMLDivElement;
const timeline = document.querySelector('#timeline') as HTMLDivElement;
const closeTimelineButton = document.querySelector(
  '#close-timeline',
) as HTMLButtonElement;
const exportPlanButton = document.querySelector(
  '#export-plan',
) as HTMLButtonElement;
const spinner = document.querySelector('#spinner') as HTMLDivElement;
const errorMessage = document.querySelector('#error-message') as HTMLDivElement;
const recentSearchesContainer = document.querySelector(
  '#recent-searches-container',
) as HTMLDivElement;
const sidebar = document.querySelector('#sidebar') as HTMLElement;
const sidebarToggle = document.querySelector(
  '#sidebar-toggle',
) as HTMLButtonElement;

// Initializes the Google Map instance and necessary libraries.
async function initMap() {
  bounds = new LatLngBounds();

  map = new Map(document.getElementById('map'), {
    center: {lat: -34.397, lng: 150.644}, // Default center
    zoom: 8, // Default zoom
    mapId: '4504f8b37365c3d0', // Custom map ID for styling
    gestureHandling: 'greedy', // Allows easy map interaction on all devices
    zoomControl: false,
    cameraControl: false,
    mapTypeControl: false,
    scaleControl: false,
    streetViewControl: false,
    rotateControl: false,
    fullscreenControl: false,
  });

  // Define a custom Popup class extending Google Maps OverlayView.
  window.Popup = class Popup extends google.maps.OverlayView {
    position;
    containerDiv;
    constructor(position, content) {
      super();
      this.position = position;

      this.containerDiv = document.createElement('div');
      this.containerDiv.classList.add('popup-container');
      this.containerDiv.appendChild(content); // Append the actual content here
      Popup.preventMapHitsAndGesturesFrom(this.containerDiv);
    }
    onAdd() {
      this.getPanes().floatPane.appendChild(this.containerDiv);
    }
    onRemove() {
      if (this.containerDiv.parentElement) {
        this.containerDiv.parentElement.removeChild(this.containerDiv);
      }
    }
    draw() {
      const divPosition = this.getProjection().fromLatLngToDivPixel(
        this.position,
      );
      const display =
        Math.abs(divPosition.x) < 4000 && Math.abs(divPosition.y) < 4000
          ? 'block'
          : 'none';
      if (display === 'block') {
        this.containerDiv.style.left = divPosition.x + 'px';
        this.containerDiv.style.top = divPosition.y + 'px';
      }
      if (this.containerDiv.style.display !== display) {
        this.containerDiv.style.display = display;
      }
    }
  };
}

// Initialize the map as soon as the script loads.
initMap();
loadRecentSearches();

// Function declaration for extracting location data using Google AI.
const locationFunctionDeclaration: FunctionDeclaration = {
  name: 'location',
  parameters: {
    type: Type.OBJECT,
    description: 'Geographic coordinates of a location.',
    properties: {
      name: {type: Type.STRING, description: 'Name of the location.'},
      description: {
        type: Type.STRING,
        description:
          'Description of the location: why is it relevant, details to know.',
      },
      lat: {type: Type.STRING, description: 'Latitude of the location.'},
      lng: {type: Type.STRING, description: 'Longitude of the location.'},
      time: {
        type: Type.STRING,
        description:
          'Time of day to visit this location (e.g., "09:00", "14:30").',
      },
      duration: {
        type: Type.STRING,
        description:
          'Suggested duration of stay at this location (e.g., "1 hour", "45 minutes").',
      },
      sequence: {
        type: Type.NUMBER,
        description: 'Order in the day itinerary (1 = first stop of the day).',
      },
    },
    required: ['name', 'description', 'lat', 'lng'],
  },
};

// Function declaration for extracting route/line data using Google AI.
const lineFunctionDeclaration: FunctionDeclaration = {
  name: 'line',
  parameters: {
    type: Type.OBJECT,
    description: 'Connection between a start location and an end location.',
    properties: {
      name: {
        type: Type.STRING,
        description: 'Name of the route or connection',
      },
      start: {
        type: Type.OBJECT,
        description: 'Start location of the route',
        properties: {
          lat: {type: Type.STRING, description: 'Latitude of the start location.'},
          lng: {type: Type.STRING, description: 'Longitude of the start location.'},
        },
      },
      end: {
        type: Type.OBJECT,
        description: 'End location of the route',
        properties: {
          lat: {type: Type.STRING, description: 'Latitude of the end location.'},
          lng: {type: Type.STRING, description: 'Longitude of the end location.'},
        },
      },
      transport: {
        type: Type.STRING,
        description:
          'Mode of transportation between locations (e.g., "walking", "driving", "public transit").',
      },
      travelTime: {
        type: Type.STRING,
        description:
          'Estimated travel time between locations (e.g., "15 minutes", "1 hour").',
      },
    },
    required: ['name', 'start', 'end'],
  },
};

// System instructions provided to the Google AI model guiding its responses.
const systemInstructions = `## System Instructions for an Interactive Map Explorer

**Model Persona:** You are a knowledgeable, geographically-aware assistant that provides visual information through maps.
Your primary goal is to answer any location-related query comprehensively, using map-based visualizations.
You can process information about virtually any place, real or fictional, past, present, or future.

**Core Capabilities:**

1. **Geographic Knowledge:** You possess extensive knowledge of:
   * Global locations, landmarks, and attractions
   * Historical sites and their significance
   * Natural wonders and geography
   * Cultural points of interest
   * Travel routes and transportation options

2. **Two Operation Modes:**

   **A. General Explorer Mode** (Default when DAY_PLANNER_MODE is false):
   * Respond to any query by identifying relevant geographic locations
   * Show multiple points of interest related to the query
   * Provide rich descriptions for each location
   * Connect related locations with appropriate paths
   * Focus on information delivery rather than scheduling

   **B. Day Planner Mode** (When DAY_PLANNER_MODE is true):
   * Create detailed day itineraries with:
     * A logical sequence of locations to visit throughout a day (typically 4-6 major stops)
     * Specific times and realistic durations for each location visit
     * Travel routes between locations with appropriate transportation methods
     * A balanced schedule considering travel time, meal breaks, and visit durations
     * Each location must include a 'time' (e.g., "09:00") and 'duration' property
     * Each location must include a 'sequence' number (1, 2, 3, etc.) to indicate order
     * Each line connecting locations should include 'transport' and 'travelTime' properties

**Output Format:**

1. **General Explorer Mode:**
   * Use the "location" function for each relevant point of interest with name, description, lat, lng
   * Use the "line" function to connect related locations if appropriate
   * Provide as many interesting locations as possible (4-8 is ideal)
   * Ensure each location has a meaningful description

2. **Day Planner Mode:**
   * Use the "location" function for each stop with required time, duration, and sequence properties
   * Use the "line" function to connect stops with transport and travelTime properties
   * Structure the day in a logical sequence with realistic timing
   * Include specific details about what to do at each location

**Important Guidelines:**
* For ANY query, always provide geographic data through the location function
* If unsure about a specific location, use your best judgment to provide coordinates
* Never reply with just questions or requests for clarification
* Always attempt to map the information visually, even for complex or abstract queries
* For day plans, create realistic schedules that start no earlier than 8:00am and end by 9:00pm

Remember: In default mode, respond to ANY query by finding relevant locations to display on the map, even if not explicitly about travel or geography. In day planner mode, create structured day itineraries.`;

// Initialize the Google AI client.
const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
});

// Functions to control the visibility of the timeline panel.
function showTimeline() {
  if (timelineView) timelineView.style.display = 'block';
  if (cardContainer) cardContainer.style.display = 'none';
}

function hideTimeline() {
  if (timelineView) timelineView.style.display = 'none';
  if (cardContainer) cardContainer.style.display = 'block';
}

function toggleSidebar(forceOpen = false) {
  if (window.innerWidth <= 820) {
    if (forceOpen) {
      sidebar.classList.add('open');
    } else {
      sidebar.classList.toggle('open');
    }
  }
}

// Renders the list of recent search prompts.
function renderRecentSearches() {
  if (!recentSearchesContainer) return;
  recentSearchesContainer.innerHTML = '';
  if (recentSearches.length === 0) return;

  const title = document.createElement('div');
  title.className = 'recent-searches-title';
  title.textContent = 'Recent';
  recentSearchesContainer.appendChild(title);

  recentSearches.forEach((prompt) => {
    const item = document.createElement('div');
    item.className = 'recent-search-item';
    item.textContent = prompt;
    item.addEventListener('click', () => {
      promptInput.value = prompt;
      generateButton.classList.add('loading');
      sendText(prompt);
      recentSearchesContainer.style.display = 'none';
    });
    recentSearchesContainer.appendChild(item);
  });
}

// Loads recent searches from localStorage.
function loadRecentSearches() {
  const storedSearches = localStorage.getItem(RECENT_SEARCHES_KEY);
  if (storedSearches) {
    try {
      recentSearches = JSON.parse(storedSearches);
      renderRecentSearches();
    } catch (e) {
      console.error('Failed to parse recent searches:', e);
      localStorage.removeItem(RECENT_SEARCHES_KEY);
    }
  }
}

// Adds a new search to the recent list and saves to localStorage.
function addRecentSearch(prompt: string) {
  if (!prompt) return;
  // Remove prompt if it already exists to move it to the top
  const index = recentSearches.indexOf(prompt);
  if (index > -1) {
    recentSearches.splice(index, 1);
  }
  recentSearches.unshift(prompt);
  if (recentSearches.length > MAX_RECENT_SEARCHES) {
    recentSearches = recentSearches.slice(0, MAX_RECENT_SEARCHES);
  }
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recentSearches));
  renderRecentSearches();
}

// Event Listeners for UI elements.
const promptInput = document.querySelector(
  '#prompt-input',
) as HTMLTextAreaElement;

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${promptInput.scrollHeight}px`;
});

promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (prompt) {
      generateButton.classList.add('loading');
      sendText(prompt);
    }
  }
});

generateButton.addEventListener('click', (e) => {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  generateButton.classList.add('loading');
  sendText(prompt);
});

resetButton.addEventListener('click', () => restart());

plannerModeToggle.addEventListener('change', () => {
  isPlannerMode = plannerModeToggle.checked;
  promptInput.placeholder = isPlannerMode
    ? "e.g. 'One day in Paris'"
    : 'Explore places, history, events...';
  if (!isPlannerMode) hideTimeline();
});

closeTimelineButton.addEventListener('click', () => hideTimeline());

exportPlanButton.addEventListener('click', () => exportDayPlan());

sidebarToggle.addEventListener('click', () => toggleSidebar());

promptInput.addEventListener('focus', () => {
  if (recentSearches.length > 0) {
    recentSearchesContainer.style.display = 'block';
  }
});

document.addEventListener('click', (event) => {
  const searchContainer = document.querySelector('.sidebar-header');
  if (!searchContainer.contains(event.target as Node)) {
    if (recentSearchesContainer) {
      recentSearchesContainer.style.display = 'none';
    }
  }
});

// Resets the map and application state to initial conditions.
function restart() {
  points = [];
  bounds = new google.maps.LatLngBounds();
  dayPlanItinerary = [];

  markers.forEach((marker) => marker.setMap(null));
  markers = [];

  lines.forEach((line) => line.geodesicPoly.setMap(null));
  lines = [];

  popUps.forEach((popup) => popup.popup.setMap(null));
  popUps = [];

  cardContainer.innerHTML = `<div class="placeholder-content">
    <i class="fas fa-map-marked-alt"></i>
    <h2>Start Exploring</h2>
    <p>Enter a prompt above to discover new places on the map.</p>
  </div>`;
  timeline.innerHTML = '';
  hideTimeline();
  errorMessage.innerHTML = '';
  promptInput.value = '';
}

// Sends the user's prompt to the Google AI and processes the response.
async function sendText(prompt: string) {
  addRecentSearch(prompt);
  spinner.classList.remove('hidden');
  errorMessage.innerHTML = '';
  restart();
  toggleSidebar(true);

  try {
    const finalPrompt = isPlannerMode ? `${prompt} day trip` : prompt;
    const updatedInstructions = isPlannerMode
      ? systemInstructions.replace('DAY_PLANNER_MODE', 'true')
      : systemInstructions.replace('DAY_PLANNER_MODE', 'false');

    const response = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: finalPrompt,
      config: {
        systemInstruction: updatedInstructions,
        temperature: 1,
        tools: [
          {functionDeclarations: [locationFunctionDeclaration, lineFunctionDeclaration]},
        ],
      },
    });

    let results = false;
    for await (const chunk of response) {
      const fns = chunk.functionCalls ?? [];
      for (const fn of fns) {
        results = true;
        if (fn.name === 'location') await setPin(fn.args);
        if (fn.name === 'line') await setLeg(fn.args);
      }
    }

    if (!results) {
      throw new Error('Could not generate any results. Please try another prompt.');
    }

    if (isPlannerMode && dayPlanItinerary.length > 0) {
      dayPlanItinerary.sort(
        (a, b) => (a.sequence || Infinity) - (b.sequence || Infinity) || (a.time || '').localeCompare(b.time || ''),
      );
      createTimeline();
      showTimeline();
    }

    createLocationCards();
  } catch (e) {
    errorMessage.innerHTML = e.message;
    console.error('Error generating content:', e);
  } finally {
    generateButton.classList.remove('loading');
    spinner.classList.add('hidden');
  }
}

// Adds a pin (marker and popup) to the map for a given location.
async function setPin(args) {
  const point = {lat: Number(args.lat), lng: Number(args.lng)};
  points.push(point);
  bounds.extend(point);

  const marker = new AdvancedMarkerElement({map, position: point, title: args.name});
  markers.push(marker);
  map.panTo(point);
  map.fitBounds(bounds);

  const content = document.createElement('div');
  content.innerHTML = `<b>${args.name}</b>`;
  const popup = new window.Popup(new google.maps.LatLng(point), content);

  const locationInfo = {
    name: args.name,
    description: args.description,
    position: new google.maps.LatLng(point),
    popup,
    content,
    time: args.time,
    duration: args.duration,
    sequence: args.sequence,
  };
  popUps.push(locationInfo);
  if (isPlannerMode && args.time) {
    dayPlanItinerary.push(locationInfo);
  }
}

// Adds a line (route) between two locations on the map.
async function setLeg(args) {
  const start = {lat: Number(args.start.lat), lng: Number(args.start.lng)};
  const end = {lat: Number(args.end.lat), lng: Number(args.end.lng)};
  points.push(start, end);
  bounds.extend(start);
  bounds.extend(end);
  map.fitBounds(bounds);

  const geodesicPolyOptions = {
    strokeColor: isPlannerMode ? '#007AFF' : '#CC0099',
    strokeOpacity: 1.0,
    strokeWeight: isPlannerMode ? 4 : 3,
    map,
  };

  if (isPlannerMode) {
    geodesicPolyOptions['icons'] = [{
      icon: {path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3},
      offset: '0',
      repeat: '15px',
    }];
  }

  const geodesicPoly = new google.maps.Polyline(geodesicPolyOptions);
  geodesicPoly.setPath([start, end]);

  lines.push({
    geodesicPoly,
    name: args.name,
    transport: args.transport,
    travelTime: args.travelTime,
    start,
    end,
  });
}

// Helper function to check if two coordinates are approximately the same.
function isSameLocation(pos1, pos2_latlng) {
  const tolerance = 0.0001; // ~11 meters
  const lat2 = pos2_latlng.lat();
  const lng2 = pos2_latlng.lng();
  return (
    Math.abs(pos1.lat - lat2) < tolerance &&
    Math.abs(pos1.lng - lng2) < tolerance
  );
}

// Helper function to get a Font Awesome icon name for a transport mode.
function getTransportIcon(transport: string): string {
  if (!transport) return 'route';
  const transportLower = transport.toLowerCase();
  if (transportLower.includes('walk')) return 'walking';
  if (transportLower.includes('driv') || transportLower.includes('car'))
    return 'car-side';
  if (
    transportLower.includes('transit') ||
    transportLower.includes('bus') ||
    transportLower.includes('train') ||
    transportLower.includes('subway')
  )
    return 'train';
  return 'route'; // Default icon
}

// Creates and populates the timeline view for the day plan, including travel legs.
function createTimeline() {
  if (!timeline || dayPlanItinerary.length === 0) return;
  timeline.innerHTML = '';

  const fullItinerary = [];
  dayPlanItinerary.forEach((item, index) => {
    fullItinerary.push({type: 'stop', data: item});
    if (index < dayPlanItinerary.length - 1) {
      const nextItem = dayPlanItinerary[index + 1];
      const leg = lines.find(
        (line) =>
          isSameLocation(line.start, item.position) &&
          isSameLocation(line.end, nextItem.position),
      );
      if (leg) {
        fullItinerary.push({type: 'travel', data: leg});
      }
    }
  });

  fullItinerary.forEach((itineraryItem) => {
    const timelineItem = document.createElement('div');
    timelineItem.className = 'timeline-item';

    if (itineraryItem.type === 'stop') {
      const item = itineraryItem.data;
      timelineItem.innerHTML = `
        <div class="timeline-time">${item.time || 'Flexible'}</div>
        <div class="timeline-connector">
          <div class="timeline-dot"></div>
          <div class="timeline-line"></div>
        </div>
        <div class="timeline-content">
          <div class="timeline-title">${item.name}</div>
          <div class="timeline-description">${item.description}</div>
          ${item.duration ? `<div class="timeline-duration">${item.duration}</div>` : ''}
        </div>`;
      timelineItem
        .querySelector('.timeline-content')
        ?.addEventListener('click', () => {
          const popupIndex = popUps.findIndex((p) => p.name === item.name);
          if (popupIndex !== -1) {
            highlightCard(popupIndex);
            map.panTo(popUps[popupIndex].position);
          }
        });
    } else if (itineraryItem.type === 'travel') {
      const leg = itineraryItem.data;
      timelineItem.classList.add('transport-item');
      timelineItem.innerHTML = `
        <div class="timeline-time"></div>
        <div class="timeline-connector">
          <div class="timeline-line"></div>
        </div>
        <div class="timeline-content">
           <i class="fas fa-${getTransportIcon(leg.transport)}"></i>
          <span>${leg.transport || 'Travel'} (${leg.travelTime || ''})</span>
        </div>`;
    }
    timeline.appendChild(timelineItem);
  });
}

// Generates a placeholder SVG image for location cards.
function getPlaceholderImage(locationName: string): string {
  let hash = 0;
  for (let i = 0; i < locationName.length; i++) {
    hash = locationName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  const letter = locationName.charAt(0).toUpperCase() || '?';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100" viewBox="0 0 120 100"><rect width="120" height="100" fill="hsl(${hue}, 50%, 60%)" /><text x="60" y="55" font-family="Inter, sans-serif" font-size="48" fill="white" text-anchor="middle" dominant-baseline="middle">${letter}</text></svg>`)}`;
}

// Creates and displays location cards in the sidebar.
function createLocationCards() {
  if (!cardContainer || popUps.length === 0) return;
  cardContainer.innerHTML = '';

  popUps.forEach((location, index) => {
    const card = document.createElement('div');
    card.className = 'location-card';
    if (index === 0) card.classList.add('card-active');

    let cardContent = `<div class="card-image" style="background-image: url('${getPlaceholderImage(
      location.name,
    )}')"></div>`;
    cardContent += `<div class="card-content">
      <h3 class="card-title">${location.name}</h3>
      <p class="card-description">${location.description}</p>
      ${isPlannerMode && location.duration ? `<div class="card-duration">${location.duration}</div>` : ''}
    </div>`;

    if (isPlannerMode) {
      if (location.sequence) {
        cardContent += `<div class="card-sequence-badge">${location.sequence}</div>`;
      }
      if (location.time) {
        cardContent += `<div class="card-time-badge">${location.time}</div>`;
      }
    }
    card.innerHTML = cardContent;
    card.addEventListener('click', () => {
      highlightCard(index);
      map.panTo(location.position);
    });
    cardContainer.appendChild(card);
  });
}

// Highlights the selected card and corresponding elements.
function highlightCard(index: number) {
  const cards = cardContainer?.querySelectorAll<HTMLElement>('.location-card');
  if (!cards) return;

  cards.forEach((card) => card.classList.remove('card-active'));
  if (cards[index]) {
    cards[index].classList.add('card-active');
    cards[index].scrollIntoView({behavior: 'smooth', block: 'center'});
  }

  popUps.forEach((popup, i) => {
    popup.popup.setMap(i === index ? map : null);
  });

  if (isPlannerMode) highlightTimelineItem(index);
}

// Highlights the timeline item corresponding to the selected card.
function highlightTimelineItem(cardIndex: number) {
  if (!timeline) return;
  const timelineItems = timeline.querySelectorAll('.timeline-content');
  timelineItems.forEach((item) => item.classList.remove('active'));

  const location = popUps[cardIndex];
  for (const item of timelineItems) {
    const title = item.querySelector('.timeline-title');
    if (title && title.textContent === location.name) {
      item.classList.add('active');
      item.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      break;
    }
  }
}

// Exports the current day plan as a simple text file.
function exportDayPlan() {
  if (!dayPlanItinerary.length) return;
  let content = '# Your Day Plan\n\n';

  dayPlanItinerary.forEach((item, index) => {
    content += `## ${index + 1}. ${item.name}\n`;
    content += `Time: ${item.time || 'Flexible'}\n`;
    if (item.duration) content += `Duration: ${item.duration}\n`;
    content += `\n${item.description}\n\n`;

    if (index < dayPlanItinerary.length - 1) {
      const nextItem = dayPlanItinerary[index + 1];
      const leg = lines.find(
        (line) =>
          isSameLocation(line.start, item.position) &&
          isSameLocation(line.end, nextItem.position),
      );
      if (leg) {
        content += `-> Travel via ${leg.transport} (${leg.travelTime})\n\n`;
      }
    }
  });

  const blob = new Blob([content], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'day-plan.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}