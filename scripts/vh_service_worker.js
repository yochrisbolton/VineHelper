const DEBUG_MODE = false; // Will always display notification even if they are not new
const VINE_HELPER_API_V5_URL = "https://api.vinehelper.ovh";
const VINE_HELPER_API_V5_WS_URL = "wss://api.vinehelper.ovh";
//const VINE_HELPER_API_V5_WS_URL = "http://127.0.0.1:3000";

importScripts("../scripts/SettingsMgr.js");

var Settings = new SettingsMgr();
var notificationsData = {};
var vineCountry = null;
var newItemCheckInterval = 0.5;
const broadcastChannel = new BroadcastChannel("VineHelperChannel");
const vineDomains = {
	ca: "ca",
	com: "com",
	uk: "co.uk",
	jp: "co.jp",
	de: "de",
	fr: "fr",
	es: "es",
	it: "it",
};
var vineDomain;

if (typeof browser === "undefined") {
	var browser = chrome;
}

//#####################################################
//## PLUGIN SYSTEM
//#####################################################

//The plugin can't be run using the official release as they are bundled and can't be changed.
//Check if the manifest.json pas the scripting permission, which is the case for the github code.
//If so, activate the plugin system.
chrome.permissions.contains({ permissions: ["scripting"] }, (result) => {
	if (result) {
		//Import plugin service workers' scripts
		importScripts("../plugins/_pluginsInit.js");
		for (let i = 0; i < ARR_PLUGIN_SERVICE_WORKERS.length; i++) {
			console.log("Importing service worker " + ARR_PLUGIN_SERVICE_WORKERS[i]);
			importScripts("../plugins/" + ARR_PLUGIN_SERVICE_WORKERS[i]);
		}

		//Import plugin content_scripts
		browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
			if (message.action === "injectPluginsContentScripts") {
				for (let i = 0; i < ARR_PLUGIN_CONTENT_SCRIPTS.length; i++) {
					// Inject the specified script into the content script context
					browser.scripting.executeScript(
						{
							target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
							files: ["plugins/" + ARR_PLUGIN_CONTENT_SCRIPTS[i]],
						},
						() => {
							if (browser.runtime.lastError) {
								console.error(browser.runtime.lastError);
							} else {
								console.log(`Imported content_script ${ARR_PLUGIN_CONTENT_SCRIPTS[i]}.`);
							}
						}
					);
				}
			}
		});
	}
});

//#####################################################
//## LISTENERS
//#####################################################
browser.runtime.onMessage.addListener((data, sender, sendResponse) => {
	if (data.type == "fetchLast100Items") {
		//Get the last 100 most recent items
		fetchLast100Items();
		sendResponse({ success: true });
	}
	if (data.type == "wsStatus") {
		sendResponse({ success: true });
		if (socket?.connected) {
			sendMessageToAllTabs({ type: "wsOpen" }, "Websocket server connected.");
		} else {
			sendMessageToAllTabs({ type: "wsClosed" }, "Websocket server disconnected.");
		}
	}
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
	await retrieveSettings();

	if (alarm.name === "checkNewItems") {
		connectWebSocket(); //Check the status of the websocket, reconnect if closed.

		if (!Settings.get("notification.active")) {
			return; //Not setup to check for notifications. Will try again in 30 secs.
		}
		//checkNewItems();
	}
});

//Websocket
importScripts("../node_modules/socket.io/client-dist/socket.io.min.js");
let socket;
function connectWebSocket() {
	if (!Settings.get("notification.active") || socket?.connected) {
		return;
	}

	socket = io.connect(VINE_HELPER_API_V5_WS_URL, {
		query: { countryCode: Settings.get("general.country") }, // Pass the country code as a query parameter
		transports: ["websocket"],
	});

	// On connection success
	socket.on("connect", () => {
		sendMessageToAllTabs({ type: "wsOpen" }, "Socket.IO server connected.");
	});

	socket.on("newItem", (data) => {
		// Assuming the server sends the data in the same format as before
		dispatchNewItem({
			index: 0,
			type: "newItem",
			domain: vineCountry,
			date: data.item.date,
			asin: data.item.asin,
			title: data.item.title,
			search: data.item.search,
			img_url: data.item.img_url,
			etv: data.item.etv,
			queue: data.item.queue,
			is_parent_asin: data.item.is_parent_asin,
			enrollment_guid: data.item.enrollment_guid,
		});

		sendMessageToAllTabs({ type: "newItemCheckEnd" }, "End of notification(s) update");
	});

	// On disconnection
	socket.on("disconnect", () => {
		sendMessageToAllTabs({ type: "wsClosed" }, "Socket.IO server disconnected.");
	});

	// On error
	socket.on("connect_error", (error) => {
		console.error(`Socket.IO error: ${error.message}`);
	});
}

//#####################################################
//## BUSINESS LOGIC
//#####################################################

init();

//Load the settings, if no settings, try again in 10 sec
async function init() {
	await retrieveSettings();

	//Check for new items (if the option is disabled the method will return)
	browser.alarms.create("checkNewItems", { periodInMinutes: newItemCheckInterval });

	connectWebSocket();
}

async function retrieveSettings() {
	//Wait for the settings to be loaded.
	while (!Settings.isLoaded()) {
		await new Promise((r) => setTimeout(r, 10));
	}

	//Set the country
	vineCountry = Settings.get("general.country");
	vineDomain = vineDomains[vineCountry];
}

async function fetchLast100Items() {
	//Broadcast a new message to tell the tabs to display a loading wheel.
	sendMessageToAllTabs({ type: "newItemCheck" }, "Loading wheel");

	const content = {
		api_version: 5,
		country: vineCountry,
		action: "get_latest_notifications",
		uuid: Settings.get("general.uuid", false),
	};
	const options = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(content),
	};

	fetch(VINE_HELPER_API_V5_URL, options)
		.then((response) => response.json())
		.then(async function (response) {
			//TODO: Client side sort the response.products array in order of response.products[i].date DESC. (most recent at the top)
			response.products.sort((a, b) => {
				const dateA = new Date(a.date);
				const dateB = new Date(b.date);
				return dateB - dateA;
			});

			for (let i = response.products.length - 1; i >= 0; i--) {
				const { title, date, asin, img_url, etv, queue, is_parent_asin, enrollment_guid } =
					response.products[i];

				//Only display notification for products with a title and image url
				if (img_url != "" && title != "") {
					dispatchNewItem({
						index: i,
						type: "newItem",
						domain: vineCountry,
						date: date,
						asin: asin,
						title: title,
						img_url: img_url,
						etv: etv,
						queue: queue,
						is_parent_asin: is_parent_asin,
						enrollment_guid: enrollment_guid,
					});
				}
			}
			sendMessageToAllTabs({ type: "newItemCheckEnd" }, "End of notification(s) update");
		})
		.catch(function () {
			(error) => console.log(error);
		});
}

function dispatchNewItem(data) {
	const search = data.title.replace(/^([a-zA-Z0-9\s',]{0,40})[\s]+.*$/, "$1");
	const highlightKWMatch = keywordMatch(Settings.get("general.highlightKeywords"), data.title);
	const hideKWMatch = keywordMatch(Settings.get("general.hideKeywords"), data.title);

	//If the new item match a highlight keyword, push a real notification.
	if (Settings.get("notification.pushNotifications") && highlightKWMatch) {
		chrome.notifications.onClicked.addListener((notificationId) => {
			const { asin, queue, is_parent_asin, enrollment_guid, search } = notificationsData[notificationId];
			if (Settings.get("general.searchOpenModal") && is_parent_asin != null && enrollment_guid != null) {
				chrome.tabs.create({
					url: `https://www.amazon.${vineDomain}/vine/vine-items?queue=encore#openModal;${asin};${queue};${is_parent_asin};${enrollment_guid}`,
				});
			} else {
				chrome.tabs.create({
					url: `https://www.amazon.${vineDomain}/vine/vine-items?search=${search}`,
				});
			}
		});

		notificationsData["item-" + data.asin] = {
			asin: data.asin,
			queue: data.queue,
			is_parent_asin: data.is_parent_asin,
			enrollment_guid: data.enrollment_guid,
			search: data.search,
		};
		chrome.notifications.create(
			"item-" + data.asin,
			{
				type: "basic",
				iconUrl: data.img_url,
				title: "Vine Helper - New item match!",
				message: data.title,
				priority: 2,
			},
			(notificationId) => {
				if (chrome.runtime.lastError) {
					console.error("Notification error:", chrome.runtime.lastError);
				}
			}
		);
	}

	//Broadcast the notification
	console.log("Broadcasting new item " + data.asin);
	sendMessageToAllTabs(
		{
			index: data.index,
			type: data.type,
			domain: vineCountry,
			date: data.date,
			asin: data.asin,
			title: data.title,
			search: search,
			img_url: data.img_url,
			etv: data.etv,
			queue: data.queue,
			KWsMatch: highlightKWMatch,
			hideMatch: hideKWMatch,
			is_parent_asin: data.is_parent_asin,
			enrollment_guid: data.enrollment_guid,
		},
		"notification"
	);
}

function keywordMatch(keywords, title) {
	return keywords.some((word) => {
		let regex;
		try {
			regex = new RegExp(`\\b${word}\\b`, "i");
		} catch (error) {
			if (error instanceof SyntaxError) {
				return false;
			}
		}

		if (regex.test(title)) {
			return true;
		}

		return false;
	});
}

async function sendMessageToAllTabs(data, debugInfo) {
	//Send to the notification monitor tab
	try {
		broadcastChannel.postMessage(data);
	} catch (e) {
		if (DEBUG_MODE) {
			console.error("Error posting message to broadcastChannel:", e);
		}
	}

	//Send to other tabs for the on screen notification
	if (Settings.get("notification.screen.active")) {
		try {
			const tabs = await browser.tabs.query({ currentWindow: true });
			const regex = /^.+?amazon\.([a-z.]+).*\/vine\/.*$/;
			tabs.forEach((tab) => {
				if (tab) {
					//Check to make sure this is a VineHelper tab:
					const match = regex.exec(tab.url);
					if (tab.url != undefined && match) {
						if (DEBUG_MODE) {
							console.log("Sending message to tab " + tab.id);
							console.log(tab.url);
						}

						try {
							browser.tabs.sendMessage(tab.id, data, (response) => {
								if (browser.runtime.lastError) {
									//console.log(tab);
									//console.error("Error sending message to tab:", browser.runtime.lastError.message);
								}
							});
						} catch (e) {
							if (DEBUG_MODE) {
								console.error("Error sending message to tab:", e);
							}
						}
					}
				}
			});
		} catch (error) {
			if (DEBUG_MODE) {
				console.error("Error querying tabs:", error);
			}
		}
	}
}

function generateUUID() {
	// Public Domain/MIT
	let d = new Date().getTime(); // Timestamp
	let d2 = (performance && performance.now && performance.now() * 1000) || 0; // Time in microseconds
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
		let r = Math.random() * 16; // Random number between 0 and 16
		if (d > 0) {
			// Use timestamp until depleted
			r = (d + r) % 16 | 0;
			d = Math.floor(d / 16);
		} else {
			// Use microseconds since timestamp depleted
			r = (d2 + r) % 16 | 0;
			d2 = Math.floor(d2 / 16);
		}
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function tryParseJSON(data) {
	try {
		const parsedData = JSON.parse(data); // Try to parse the JSON string

		// Check if the parsed result is an object
		if (parsedData && typeof parsedData === "object") {
			return parsedData; // Return the parsed object
		}
	} catch (e) {
		// If JSON parsing fails, return null or handle the error
		return null;
	}

	return null; // If not JSON, return null
}
