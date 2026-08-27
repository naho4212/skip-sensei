/*
 * Ad Sensei — Spotify audio-ad SKIP engine (MAIN world), beta.
 *
 * Ported from [AdSensei/spotify-skip] (github.com/tomer8007/spotify-web-ads-remover, MIT,
 * (c) tomer8007) — intercepts the Spotify web player's /state responses and
 * rewrites its playback state machine so states whose track is an ad
 * (uri contains ":ad:") are skipped over, pulling future states from Spotify
 * when needed. This genuinely removes the ad (no audio plays) rather than
 * muting it. Adapted for Ad Sensei: SweetAlert popups replaced with console
 * logs, on-page counter replaced with a postMessage to the isolated content
 * script (src/content/spotify-skip.ts) for the activity log.
 *
 * Gated by chrome.scripting registration (src/spotify-skip-register.ts) —
 * injected ONLY while the beta "Skip Spotify audio ads" setting is on, so
 * there is zero page-world footprint otherwise. The tab-mute muter
 * (src/content/audio-ads.ts) stays on as the fallback for anything this misses.
 *
 * WebSocket hook (wsHook) below is based on skepticfx/wshook.
 */

if (window.__adSenseiSpotifySkipLoaded) {
  console.log('[AdSensei/spotify-skip] already loaded, skipping re-init')
} else {
  window.__adSenseiSpotifySkipLoaded = true

// ===== WebSocket interception (wsHook, based on skepticfx/wshook) =====
// wsHook - WebSocket Interception
	// based on https://github.com/skepticfx/wshook

	var wsHook = {};

	(function() 
	{
		var before = wsHook.before = function(data, url) 
		{
			return new Promise(function(resolve, reject)
    		{
				resolve(data);
			});
		};
		var after = wsHook.after = function(e, url) 
		{
			return e;
		};
		wsHook.resetHooks = function() 
		{
			wsHook.before = before;
			wsHook.after = after;
		}

		var _WS = WebSocket;
		WebSocket = function(url, protocols) 
		{
			var WSObject;
			this.url = url;
			this.protocols = protocols;
			if (!this.protocols)
			WSObject = new _WS(url);
			else
			WSObject = new _WS(url, protocols);

			var _send = WSObject.send;
			var _wsobject = this;
			wsHook._send = WSObject.send = function(data) 
			{
				//data = wsHook.before(data, WSObject.url) || data;
				new wsHook.before(data, WSObject.url).then(function (newData)
				{
					if (newData != null)
						_send.apply(WSObject, [newData]);
					
				}).catch(function(e)
				{
					console.error(e);
					_send.apply(WSObject, [newData]);  
				});
			}

			// Events needs to be proxied and bubbled down.
			var onmessageFunction;
			WSObject.__defineSetter__('onmessage', function(func) 
			{
				onmessageFunction = wsHook.onMessage = func;
			});
			WSObject.addEventListener('message', function(event) 
			{
				if (!onmessageFunction)
				{
					console.log("warning: no onmessageFunction");
					return;
				}
			
				wsHook.after(new MutableMessageEvent(event), this.url).then(function(modifiedEvent)
				{
					if (modifiedEvent != null)
						onmessageFunction.apply(this, [modifiedEvent]);
					
				}).catch(function(e)
				{
					console.error(e);
					onmessageFunction.apply(this, [event]);
				});
				
				//e = new MessageEvent(e.type, e);
			});

			return WSObject;
		}
	})();

	// Mutable MessageEvent.
	// Subclasses MessageEvent and makes data, origin and other MessageEvent properites mutatble.
	function MutableMessageEvent(o) 
	{
		this.bubbles = o.bubbles || false;
		this.cancelBubble = o.cancelBubble || false;
		this.cancelable = o.cancelable || false;
		this.currentTarget = o.currentTarget || null;
		this.data = o.data || null;
		this.defaultPrevented = o.defaultPrevented || false;
		this.eventPhase = o.eventPhase || 0;
		this.lastEventId = o.lastEventId || "";
		this.origin = o.origin || "";
		this.path = o.path || new Array(0);
		this.ports = o.parts || new Array(0);
		this.returnValue = o.returnValue || true;
		this.source = o.source || null;
		this.srcElement = o.srcElement || null;
		this.target = o.target || null;
		this.timeStamp = o.timeStamp || null;
		this.type = o.type || "message";
		this.__proto__ = o.__proto__ || MessageEvent.__proto__;
	}

// ===== Ad removal via state-machine rewrite (from SpotiAds) =====
var currentTracks = [];
var removedAdsList = [];
var tamperedStatesMap = {};
var deviceId = "";

var totalAdsRemoved = 0;

var originalFetch = window.fetch;
var isFetchInterceptionWorking = false;
var isWebScoketInterceptionWorking = false;
var isSimulatingStateChnage = false;
var didShowMultiDeviceWarning = false;
var didShowInterceptionWarning = false;
var didCheckForInterception = false;


var accessToken = "";
var clientToken = "";
var authorizationHeader = "";

startObserving();

window.postMessage({ source: 'adSenseiSpotifySkip', type: 'ready' }, 'https://open.spotify.com');


//
// Hook the fetch() function.
//
window.fetch = function(url, init)
{
    var url = typeof(url) == 'string' ? url : url.toString();

    if (url != undefined && url.includes("/state"))
    {
        if (init.headers["authorization"])
            authorizationHeader = init.headers["authorization"];
        if (init.headers["client-token"])
            clientToken = init.headers["client-token"];

        var request = JSON.parse(init.body);
        if (request["state_ref"]["state_id"].includes("future_"))
        {
            console.log("[AdSensei/spotify-skip]: Changing Spotify's states request to reflect future state machine");

            var stateMachineId = request["state_ref"]["state_id"].split("+")[1];
            var stateId = request["state_ref"]["state_id"].split("+")[2];

            request["state_ref"]["state_id"] = stateId;
            request["state_ref"]["state_machine_id"] = stateMachineId;

            init.body = JSON.stringify(request);
        }

        return originalFetch.call(window, url, init).then(function(response)
        {
            // TODO: what do we do  on 429 here?
            var modifiedResponse = onStatesFetchResponseReceived(url, init, response);
            return modifiedResponse;
        });
    }
    else if (url != undefined && url.endsWith("/devices"))
    {
        var request = JSON.parse(init.body);
        deviceId = request.device.device_id;
    }
    else if (url.includes("get_access_token"))
    {
        return originalFetch.call(window, url, init).then(function(response)
        {
            onAccessTokenResponseIntercepted(response);
            return response;
        });
    }
    else if (url.includes("/license"))
    {
        // DRM license request. 
        return originalFetch.call(window, url, init).then(function(response)
        {
            if (response.status == 429)
            {
                onTooManyRequestsError();
            }
            return response;
        });
    }

    // Make the original request.
    var fetchResult = originalFetch.call(window, url, init);
    return fetchResult;
};

async function onAccessTokenResponseIntercepted(accessTokenResponse)
{
    var resultJson = await accessTokenResponse.json();

    console.log("[AdSensei/spotify-skip]: access token received.");

    if (accessTokenResponse.status != 200)
    {
        console.error("[AdSensei/spotify-skip]: Could not refresh access token. error:");
        console.error(resultJson);
        throw "Can't refresh access token";
    }
    accessToken = resultJson["accessToken"];
}

//
// Hook the WebSocket channel.
//
wsHook.after = function(messageEvent, url) 
{
    return new Promise(async function(resolve, reject)
    {
        var data = JSON.parse(messageEvent.data);
        if (data.payloads == undefined) {resolve(messageEvent); return;}

        for (var i = 0; i < data.payloads.length; i++)
        {
            var payload = data.payloads[i];
            if (payload.type == "replace_state")
            {
                var stateMachine = payload["state_machine"];
                var stateRef = payload["state_ref"];
                if (stateRef != null) 
                {
                    var currentStateIndex = stateRef["state_index"];
    
                    payload["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, true);
                    data.payloads[i] = payload;
    
                    isWebScoketInterceptionWorking = true;
                }
    
                if (isSimulatingStateChnage) 
                {
                    // Block this notification from reaching the client, to prevent song change.
                    return new MessageEvent(messageEvent.type, {data: "{}"});
                }
            }
            else if (payload.cluster != undefined)
            {
                if (payload.update_reason == "DEVICE_STATE_CHANGED")
                {
                    if (deviceId != payload.cluster.active_device_id)
                    {
                        // TODO: Find a way to really detect when another device is playing
                        // instead of having false positives

                        // showMultiDeviceWarning();
                    }

                    if (payload.cluster.player_state.track.provider == "ads/inject_tracks")
                    {
                        console.log("[AdSensei/spotify-skip]: Spotify tring to inject ads? advertiser: " + payload.cluster.player_state.track.metadata.advertiser);
                        //payload.cluster.player_state.restrictions = {};
                        payload.cluster.player_state.track = null;
                        data.payloads[i] = payload;
                        data.payloads[i] = null; // do we want to nullify the state?
                    }
                }
            }
        }

        messageEvent.data = JSON.stringify(data);

        resolve(messageEvent);
    });
}

function onStatesFetchResponseReceived(url, init, responseBody)
{
    var requestBody = init.body;
    var request = JSON.parse(requestBody);

    var originalJsonPromise = responseBody.json();
    responseBody.json = function()
    {
        return originalJsonPromise.then(async function(data)
        {
            var stateMachine = data["state_machine"];           
            var updatedStateRef = data["updated_state_ref"];    

            var commands = data["commands"]; // for /state_conflict
            if (commands != null)
            {
                for (var key of Object.keys(commands))
                {
                    var stateMachine = data["commands"][key]["state_machine"];           
                    var currentStateIndex = data["commands"][key]["state_ref"]["state_index"];

                    data["commands"][key]["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, false);
        
                    isFetchInterceptionWorking = true;

                }
            }
            else
            {
                if (stateMachine == undefined || updatedStateRef == null) return data;

                var currentStateIndex = updatedStateRef["state_index"];
    
                data["state_machine"] = await manipulateStateMachine(stateMachine, currentStateIndex, false);
    
                isFetchInterceptionWorking = true;
            }
            return data;

        }).catch(function(reason)
        {
            console.error(reason);
        });
    };
    
    return responseBody;
}

async function manipulateStateMachine(stateMachine, startingStateIndex, isReplacingState)
{
    
    do
    {
        var removedAds = false;
        console.log("[AdSensei/spotify-skip]: We see state machine: " + getStateMachineDestripction(stateMachine) + " (state machine id: " + stateMachine["state_machine_id"] + ")");

        for (var i = 0; i < stateMachine["states"].length; i++)
        {
            var state = stateMachine["states"][i];
            var stateId = stateMachine["states"][i]["state_id"];
            var currentStateIdNormalized = getFutureStateId(stateId);
            
            var trackID = state["track"];
            var track = stateMachine["tracks"][trackID];

            if (track == null) continue; // might happen for filler states

            var trackURI = track["metadata"]["uri"];
            var trackName = track["metadata"]["name"];


            var newState = structuredClone(state);

            if (isAd(state, stateMachine))
            {   
                console.log("[AdSensei/spotify-skip]: Encountered ad in " + trackURI);

                newState = getNextAdFreeState(stateMachine, stateId, i);
                if (isAd(newState, stateMachine))
                {
                    // We can't really skip over this state because we don't know where to skip to.
                    // We will request even more states, or, if this fails, at least shorten the ad.
                    console.log("[AdSensei/spotify-skip]: Requesting future state machine.");
                    
                    try
                    {
                        var [nextNextState, futureStateMachine] = await getNextAdFreeStateFromFutureStateMachine(stateMachine, newState);
                        if (nextNextState != null)
                        {
                            newState = nextNextState;

                            var originalNextStateId = newState["state_id"];

                            var nextTrackName = futureStateMachine["tracks"][newState["track"]]["metadata"]["name"];
                            console.log("[AdSensei/spotify-skip]: after the ad we have track '" + nextTrackName + "'.");

                            
                            // Fix the new state to be suitable for replacing in the currenet state machine.
                            console.log("Spotiads: Inserting new state from future state machine");
                            var wantedStateId = state["state_id"];
                            var [fixedState, fixedStateMachine] = fixStateForOldStateMachine(newState, futureStateMachine, wantedStateId, stateMachine);
                            newState = fixedState;
                            stateMachine = fixedStateMachine;

                                
                            // if (i == startingStateIndex && !isReplacingState) 
                            // {
                            //     // Our new state is going to be played now, let's point the player at the future state machine.
                            //     newState["state_id"] = originalNextStateId;
                            //     stateMachine["state_machine_id"] = futureStateMachine["state_machine_id"];

                            //     console.log("[AdSensei/spotify-skip]: Removed ad at " + trackURI + ", more complex flow");
                            // }
                        }
                        else
                        {
                            state = shortenedState(state, track);
                            console.log("[AdSensei/spotify-skip]: Shortned ad");
                            debugger;
                        }
                        
                    }
                    catch (exception)
                    {
                        state = shortenedState(state, track);
                        console.log("[AdSensei/spotify-skip]: Shortned ad at " + trackURI + " due to exception:");
                        console.error(exception);
                        console.error(exception.stack);
                    }
                }
                else
                {
                    console.log("[AdSensei/spotify-skip]: after the ad we have track '" + nextTrackName + "'. (easy flow)");
                }

                // We don't want tracks with no transitions
                // We'll request more states to discover the better state with the transitions
                if ((newState["transitions"]["advance"] == null && newState["disallow_seeking"] == true) && !isAd(newState, futureStateMachine))
                {
                    var track = stateMachine["tracks"][newState["track"]];
                    var trackName = track["metadata"]["name"];

                    console.log("[AdSensei/spotify-skip]: Encountered a track '" + trackName + "' that disallows seeking. Requesting more states");
                    
                    [futureStateMachine, stateRef] = await getStates(stateMachine["state_machine_id"], newState["state_id"]);
                    if (futureStateMachine != null)
                    {
                        newState = futureStateMachine["states"][stateRef["state_index"]];
                        
                        console.log("Spotiads: Inserting fixed track with transitions from future state machine");
                        var wantedStateId = state["state_id"];
                        var [fixedState, fixedStateMachine] = fixStateForOldStateMachine(newState, futureStateMachine, wantedStateId, stateMachine);
                        newState = fixedState;
                        stateMachine = fixedStateMachine;
                    }
                    else
                    {
                        console.log("[AdSensei/spotify-skip]: Can't get more states, hacking the next state");
                        debugger;

                        newState["disallow_seeking"] = false;
                        newState["restrictions"] = {};
                    }
                    
                }

                currentStateIdNormalized = getFutureStateId(newState["state_id"]);

                if (newState != null && state["state_id"] != newState["state_id"]) 
                {
                    // We succesfully found the next state after the ad.
                    // Remove ads in the casual flow
                    // Make this state equal to the next one.
                    state = newState;

                    tamperedStatesMap[currentStateIdNormalized] = trackURI;

                    removedAds = true;
                }

                // Replace the current state.
                stateMachine["states"][i] = state;
            }

            if (i == startingStateIndex && !isReplacingState && tamperedStatesMap[currentStateIdNormalized] != null) 
            {
                // Our new ad-free state is going to be played now.
                var removedAdUri = tamperedStatesMap[currentStateIdNormalized];
                console.log("[AdSensei/spotify-skip]: Removed ad at " + removedAdUri);
                onAdRemoved(removedAdUri);
            }

        }

    }
    while (removedAds);

    stateMachine = tryToRemoveAdTracks(stateMachine);

    currentTracks = stateMachine["tracks"];

    return stateMachine;
}

async function getNextAdFreeStateFromFutureStateMachine(stateMachine, nextState)
{
    try
    {
        var maxAttempts = 5;
        var j = 0;
        var futureStateMachine = stateMachine;
        do
        {
            var stateMachineId = futureStateMachine["state_machine_id"];
            var stateId = nextState["state_id"];

            if (nextState["state_id"].includes("future_"))
            {
                stateMachineId = nextState["state_id"].split("+")[1];
                stateId = nextState["state_id"].split("+")[2];
            }

            [futureStateMachine, stateRef] = await getStates(stateMachineId, stateId);
            nextState = getNextAdFreeState(futureStateMachine, stateId);

            j++;
        }
        while (isAd(nextState, futureStateMachine) && j < maxAttempts)
        
        if (isAd(nextState, futureStateMachine))
        {
            // print out debugging information
            console.error("could not find the next ad-free state. state machine was:");
            console.error(futureStateMachine);
            debugger;
            return [null, futureStateMachine];
        }

    }
    catch (exception)
    {
        console.error(exception);
        console.error(exception.stack);

        return [null, futureStateMachine];
    }

    return [nextState, futureStateMachine];
}

function fixStateForOldStateMachine(stateFromNewStateMachineToFix, futureStateMachine, expectedStateId, stateMachine)
{
    var futureStateMachineId = futureStateMachine["state_machine_id"];
    stateFromNewStateMachineToFix["state_id"] = "_future_+" + futureStateMachineId + "+" + stateFromNewStateMachineToFix["state_id"];
    var track = futureStateMachine["tracks"][stateFromNewStateMachineToFix["track"]];
    stateMachine["tracks"].push(track);
    stateFromNewStateMachineToFix["track"] = stateMachine["tracks"].length - 1;

    // Fix transitions
    // TODO: we can do this recursively
    for (const [key, value] of Object.entries(stateFromNewStateMachineToFix["transitions"]))
    {
        if (value == null) continue;

        var transitionStateId = value["state_index"];
        var transitionState = futureStateMachine["states"][transitionStateId];
        if (transitionState == null) continue; // this might happen, maybe it means "fetch for more states"

        var track = futureStateMachine["tracks"][transitionState["track"]];
        stateMachine["tracks"].push(track);
        transitionState["track"] = stateMachine["tracks"].length - 1;
        transitionState["state_id"] = "_future_+" + futureStateMachineId + "+" + transitionState["state_id"];

        stateMachine["states"].push(transitionState);
        stateFromNewStateMachineToFix["transitions"][key]["state_index"] = stateMachine["states"].length - 1;

    }

    // Maybe we don't want that. let the calling code do this in a more controlled fashion
    // for (var i = 0; i < stateMachine["states"].length; i++)
    // {
    //     var state = stateMachine["states"][i];
    //     if (state["state_id"] == expectedStateId)
    //     {
    //         // Replace the original state with the fixed state from the future state machine
    //         stateMachine[i] = stateFromNewStateMachineToFix
    //     }
    // }

    return [stateFromNewStateMachineToFix, stateMachine];
}

function shortenedState(state, track)
{
    var trackDuration = track["metadata"]["duration"];

    state["disallow_seeking"] = false;
    state["restrictions"] = {};
    state["initial_playback_position"] = trackDuration;
    state["position_offset"] = trackDuration;

    return state;
}

async function getStates(stateMachineId, startingStateId, maxRetries = 3)
{
    if (startingStateId.includes("future_"))
    {
        console.log("[AdSensei/spotify-skip]: getStates: changing request to reflect future state machine");

        stateMachineId = startingStateId.split("+")[1];
        startingStateId = startingStateId.split("+")[2];
    }

    var statesUrl = "https://spclient.wg.spotify.com/track-playback/v1/devices/" + deviceId + "/state";
    var body = {"seq_num":0,"state_ref":{"state_machine_id":stateMachineId, "state_id": startingStateId,"paused":false},
            "sub_state":{"playback_speed":1,"position":0,"duration":0,"stream_time":0,"media_type":"AUDIO","bitrate":160000},"previous_position":0
            ,"debug_source":"resume"};

    var authorizationHeaderToPut = authorizationHeader ? authorizationHeader : "Bearer " + accessToken;
    var clientTokenToPut = clientToken ? clientToken : "";

    var result = await originalFetch.call(window, statesUrl,{method: 'PUT', headers: {
        'Authorization': authorizationHeaderToPut, 'client-token': clientTokenToPut,  'Content-Type': 'application/json'}, 
         body: JSON.stringify(body)});
    if (result.status != 200) 
    {

        if (result.status == 204)
        {
            // TODO: what does 204 No Content mean? no future state machine known?
        }
        // Assume the access token has expired without checking it too much.
        // var resultJson = await result.json();
        // var looksExpired = (resultJson["error"] && resultJson["error"]["message"] == "The access token expired")

        onStateMachineError(result.status);
        throw Error("[AdSensei/spotify-skip]: Failed to get states, http status code " + result.status);

        // // Refresh the access token and try again.
        // await refreshAccessToken();
        // result = await originalFetch.call(window, statesUrl,{method: 'PUT', headers: {'Authorization': "Bearer " + accessToken, 'Content-Type': 'application/json'}, 
        //                                                     body: JSON.stringify(body)});
    }

    // TODO: There is a case where the request will return a 502 Error code.
    // This will return a null stateMachine, and just shorten the ad instead of removing it.
    // Retry for now
    
    var resultJson = await result.json();
    var stateMachine = resultJson["state_machine"];
    var stateRef = resultJson["updated_state_ref"];
    if (!stateMachine)
    {
        debugger;
        if (maxRetries > 0)
            return getStates(stateMachineId, startingStateId, --maxRetries)
    }

    return [stateMachine, stateRef];
}

function* statesGenerator(states, startingStateIndex = 2, nextStateName = "skip_next")
{
    var currentState = states[startingStateIndex];
    var iterationCount = 0;

    for (var state = currentState; state != undefined; state = states[state["transitions"][nextStateName]["state_index"]])
    {
        iterationCount++;

        yield state;

        var nextTransition = state["transitions"][nextStateName];
        if (nextTransition == undefined) break;
    }

    return iterationCount;
}

function getNextAdFreeState(stateMachine, stateId, startingStateIndex = 2, excludeAds = true)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];
    var previousState = null;

    var foundTrack = false;
    var foundState = false;
    for (var state of statesGenerator(states, startingStateIndex, "advance"))
    {
        var trackID = state["track"];
        var track = tracks[trackID];
        
        // if (foundTrack) 
        // {
        //     if (excludeAds && track["content_type"] == "AD") continue;
        //     return state;
        // }
        if (foundState) 
        {
            if (excludeAds && track["content_type"] == "AD") continue;
            return state;
        }

        if (previousState == state)
        {
            console.error("Cyclic state machine detected.");
            debugger;
            return state;
        }

        //foundTrack = (track["metadata"]["uri"] == sourceTrack["metadata"]["uri"]);
        foundState = state["state_id"] == stateId;
        previousState = state;

    }

    return state;
}

function getStateMachineDestripction(stateMachine, startingStateIndex = 2)
{
    var stateMachineString = "";
    for (var state of statesGenerator(stateMachine["states"], startingStateIndex, "advance"))
    {
        var trackID = state["track"];
        var track = stateMachine["tracks"][trackID];
        var trackName = track["metadata"]["name"];

        if (isAd(state, stateMachine))
        {
            trackName = "[AD] " + trackName;
        }

        stateMachineString += trackName + " > ";
    }

    return stateMachineString;
}

function getFutureStateId(stateId)
{
    if (stateId.includes("future_"))
        stateId = stateId.split("+")[2];

    return stateId;
}

function getPreviousState(stateMachine, sourceTrack, startingStateIndex = 2)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];
    
    var foundTrack = false;
    for (var state of statesGenerator(states, startingStateIndex, "advance"))
    {
        if (state["transitions"]["advance"] == null) return null;
        
        var nextState = states[state["transitions"]["advance"]["state_index"]];
        var nextStateTrack = tracks[nextState["track"]];

        if (nextStateTrack["metadata"]["uri"] == sourceTrack["metadata"]["uri"])
        {
            return state;
        }

    }

    return null;
}

// TODO: this function does not actually help in removing ads, it's useless
function tryToRemoveAdTracks(stateMachine)
{
    var tracks = stateMachine["tracks"];

    for (var i = 0; i < tracks.length; i++)
    {
        if (isAdTrack(tracks[i]))
        {
            console.log("[AdSensei/spotify-skip]: trying to remove ad track " + tracks[i]["metadata"]["uri"]);
            //debugger;
            tracks[i] = null;
        }
    }

    stateMachine["tracks"] = tracks;
    return stateMachine;
}

function isAd(state, stateMachine)
{
    var states = stateMachine["states"];
    var tracks = stateMachine["tracks"];

    var trackID = state["track"];
    var track = tracks[trackID];

    if (state["state_id"].includes("filler"))
    {
        //console.log("[AdSensei/spotify-skip]: Encountered filler state, assuming not an ad");
        return false;
    }

    return isAdTrack(track);
}

function isAdTrack(track)
{
    if (track == null) return false;

    var trackURI = track["metadata"]["uri"];

    return trackURI.includes(":ad:");
}

//
// Graphics
//

function onMainUIReady(addedNode) { /* snackbar removed */ }

function onAdRemoved(trackURI, skipped = false)
{
    if (!removedAdsList.includes(trackURI))
    {
        removedAdsList.push(trackURI);
        if (skipped)
            showToast("Skipped ad");
        else
            showToast("Removed ad");

        totalAdsRemoved++;

        window.postMessage({ source: 'adSenseiSpotifySkip', type: 'adSkipped', total: totalAdsRemoved }, 'https://open.spotify.com');
    }
}

var lastMissedAdTime = 0;

function onAdCouldntBeRemoved(trackURI)
{
    console.log("[AdSensei/spotify-skip]: Could not remove ad at " + trackURI + " because it is currently playing");

    var now = new Date();

    if (now - lastMissedAdTime > 60000)
    {
        console.warn("[AdSensei/spotify-skip] notice suppressed");
    }

    lastMissedAdTime = now;
}

var lastStateMachineErrorTime = 0;

function onStateMachineError(errorCode)
{
    var now = new Date();

    if (now - lastStateMachineErrorTime > 60000)
    {
        console.warn("[AdSensei/spotify-skip] notice suppressed");
    }

    lastStateMachineErrorTime = now;
}


var lastTooMayyReqeustsErrorTime = 0;

function onTooManyRequestsError()
{
    var now = new Date();

    if (now - lastTooMayyReqeustsErrorTime > 9000)
    {
        console.warn("[AdSensei/spotify-skip] notice suppressed");
    }

    lastTooMayyReqeustsErrorTime = now;
}

function showToast(text) { /* no on-page toast; the popup shows the count */ }

function onSongResumed()
{
    setTimeout(checkInterception, 5000);
}

function checkInterception()
{
    var isInterceptionWorking = isFetchInterceptionWorking && isWebScoketInterceptionWorking;
    if (isInterceptionWorking)
    {
        if (!didCheckForInterception) 
            console.log("[AdSensei/spotify-skip]: Interception is working.");
        didCheckForInterception = true;
    }
    else if (!didShowInterceptionWarning && !didShowMultiDeviceWarning)
    {
        console.warn("[AdSensei/spotify-skip] notice suppressed");

        didShowInterceptionWarning = true;
    }
}

function showMultiDeviceWarning()
{
    if (!didShowMultiDeviceWarning)
    {
        console.warn("[AdSensei/spotify-skip] notice suppressed");

        didShowMultiDeviceWarning = true;
    }
}

function startObserving()
{
    var mutationObserver = new MutationObserver(function (mutationList)
    {
        mutationList.forEach( (mutation) => {
            switch(mutation.type) {
              case 'childList':
                /* One or more children have been added to and/or removed
                   from the tree. */
                   var addedNodes = mutation.addedNodes;
       
                   for (var j = 0; j < addedNodes.length; j++)
                   {
                       var addedNode = addedNodes[j];
                       if (addedNode.getAttribute == undefined) continue;
           
                       if (addedNode.getAttribute("role") == "row")
                       {
                           // Song row added.
                       }
       
                       if (addedNode.id && addedNode.id.includes("main"))
                       {
                           onMainUIReady(addedNode);
                           setTimeout(onMainUIReady, 2000); // seems like "main" gets deleted after a while
                       }
                   }
                   
                break;
              case 'attributes':
                /* An attribute value changed on the element in
                   mutation.target. */
                   var changedNode = mutation.target;
                   if (changedNode.getAttribute("aria-label") == "Pause")
                   {
                        onSongResumed();
                   }
                   
                break;
            }
          });
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ["aria-label"] });

    setTimeout(function()
    {
        if (document.getElementById("main"))
        {
            var mainElement = document.getElementById("main");
            onMainUIReady(mainElement);
        }

    }, 9000);
}

// _parseProvidedToken
//_refreshToken
// _lastToken
// async function refreshAccessToken()
// {
//     console.log("[AdSensei/spotify-skip]: Refreshing access token.");

//     var getTokenUrl = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player&totp=824945&totpVer=5";

//     // get access token
//     var result = await fetch(getTokenUrl, {credentials: "same-origin"});
//     var resultJson = await result.json();

//     if (result.status != 200)
//     {
//         console.error("[AdSensei/spotify-skip]: Could not refresh access token. error:");
//         console.error(resultJson);
//         throw "Can't refresh access token";
//     }
//     accessToken = resultJson["accessToken"];
// }

} // end __adSenseiSpotifySkipLoaded guard
