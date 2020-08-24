// ISC License
// Original work Copyright (c) 2017, Andreas Bauer
// Modified work Copyright 2018, Sander van Woensel
// Modified work Copyright 2020, Albert Attia

"use strict";

// -----------------------------------------------------------------------------
// Module variables
// -----------------------------------------------------------------------------
let Service, Characteristic, api;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------


const _http_base = require("homebridge-http-base");
const http = _http_base.http;
const configParser = _http_base.configParser;
const PullTimer = _http_base.PullTimer;
const notifications = _http_base.notifications;
const MQTTClient = _http_base.MQTTClient;
const Cache = _http_base.Cache;
const utils = _http_base.utils;

const PACKAGE_JSON = require('./package.json');
const MANUFACTURER = PACKAGE_JSON.author.name;
const SERIAL_NUMBER = '001';
const MODEL = PACKAGE_JSON.name;
const FIRMWARE_REVISION = PACKAGE_JSON.version;


const MIN_LUX_VALUE = 0.0;
const MAX_LUX_VALUE =  Math.pow(2, 16) - 1.0; // Default BH1750 max 16bit lux value.

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    api = homebridge;
    
    homebridge.registerAccessory(MODEL,"HTTP-AMBIENT-LIGHT", HttpAmbientLightSensor);
};



// -----------------------------------------------------------------------------
// Module public functions
// -----------------------------------------------------------------------------

function HttpAmbientLightSensor(log, config) {
    this.log = log;
    this.name = config.name;
    this.debug = config.debug || false;
    this.minSensorValue = config.minValue || MIN_LUX_VALUE;
    this.maxSensorValue = config.maxValue || MAX_LUX_VALUE;

    if (config.getUrl) {
        try {
            this.getUrl = configParser.parseUrlProperty(config.getUrl);
        } catch (error) {
            this.log.warn("Error occurred while parsing 'getUrl': " + error.message);
            this.log.warn("Aborting...");
            return;
        }
    }
    else {
        this.log.warn("Property 'getUrl' is required!");
        this.log.warn("Aborting...");
        return;
    }

    this.statusCache = new Cache(config.statusCache, 0);
    this.statusPattern = /(-?[0-9]{1,3}(\.[0-9])?)/;
    try {
        if (config.statusPattern)
            this.statusPattern = configParser.parsePattern(config.statusPattern);
    } catch (error) {
        this.log.warn("Property 'statusPattern' was given in an unsupported type. Using default one!");
    }
    this.patternGroupToExtract = 1;
    if (config.patternGroupToExtract) {
        if (typeof config.patternGroupToExtract === "number")
            this.patternGroupToExtract = config.patternGroupToExtract;
        else
            this.log.warn("Property 'patternGroupToExtract' must be a number! Using default value!");
    }

    this.homebridgeService = new Service.LightSensor(this.name);
    this.homebridgeService.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
        .setProps({
                    minValue: this.minSensorValue,
                    maxValue: this.maxSensorValue
                })
        .on("get", this.getSensorValue.bind(this));

    /** @namespace config.pullInterval */
    if (config.pullInterval) {
        this.pullTimer = new PullTimer(log, config.pullInterval, this.getSensorValue.bind(this), value => {
            this.homebridgeService.setCharacteristic(Characteristic.CurrentAmbientLightLevel, value);
        });
        this.pullTimer.start();
    }

    /** @namespace config.notificationPassword */
    /** @namespace config.notificationID */
    notifications.enqueueNotificationRegistrationIfDefined(api, log, config.notificationID, config.notificationPassword, this.handleNotification.bind(this));

    /** @namespace config.mqtt */
    if (config.mqtt) {
        let options;
        try {
            options = configParser.parseMQTTOptions(config.mqtt);
        } catch (error) {
            this.log.error("Error occurred while parsing MQTT property: " + error.message);
            this.log.error("MQTT will not be enabled!");
        }

        if (options) {
            try {
                this.mqttClient = new MQTTClient(this.homebridgeService, options, this.log);
                this.mqttClient.connect();
            } catch (error) {
                this.log.error("Error occurred creating MQTT client: " + error.message);
            }
        }
    }
}

HttpAmbientLightSensor.prototype = {

     identify: function (callback) {
      this.log("Identify requested!");

      if (this.identifyUrl) {
         http.httpRequest(this.identifyUrl, (error, response, body) => {

             if (error) {
                this.log("identify() failed: %s", error.message);
                callback(error);
             }
             else if (response.statusCode !== 200) {
                this.log("identify() returned http error: %s", response.statusCode);
                callback(new Error("Got http error code " + response.statusCode));
             }
             else {
                callback(null);
             }
         });
      }
      else {
         callback(null);
      }

    },

    getServices: function () {
        if (!this.homebridgeService)
            return [];

        const informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
            .setCharacteristic(Characteristic.Model, MODEL)
            .setCharacteristic(Characteristic.SerialNumber, SERIAL_NUMBER)
            .setCharacteristic(Characteristic.FirmwareRevision, FIRMWARE_REVISION);

        return [informationService, this.homebridgeService];
    },

    handleNotification: function(body) {
         const value = body.value;

        /** @namespace body.characteristic */
        let characteristic;
        switch (body.characteristic) {
            case "CurrentAmbientLightLevel":
                characteristic = Characteristic.CurrentAmbientLightLevel;
                break;
            default:
                this.log("Encountered unknown characteristic handling notification: " + body.characteristic);
                return;
        }

        if (this.debug)
            this.log("Updating '" + body.characteristic + "' to new value: " + body.value);
        this.homebridgeService.setCharacteristic(characteristic, value);
    },

    getSensorValue: function (callback) {
        if (!this.statusCache.shouldQuery()) {
            const value = this.homebridgeService.getCharacteristic(Characteristic.CurrentAmbientLightLevel).value;
            if (this.debug)
                this.log(`getSensorValue() returning cached value ${value}${this.statusCache.isInfinite()? " (infinite cache)": ""}`);

            callback(null, value);
            return;
        }

        http.httpRequest(this.getUrl, (error, response, body) => {
            if (this.pullTimer)
                this.pullTimer.resetTimer();

            if (error) {
                this.log("getSensorValue() failed: %s", error.message);
                callback(error);
            }
            else if (!http.isHttpSuccessCode(response.statusCode)) {
                this.log("getSensorValue() returned http error: %s", response.statusCode);
                callback(new Error("Got http error code " + response.statusCode));
            }
            else {
                let sensorValue;
                try {
                    sensorValue = utils.extractValueFromPattern(this.statusPattern, body, this.patternGroupToExtract);
                } catch (error) {
                    this.log("getSensorValue() error occurred while extracting sensor value from body: " + error.message);
                    callback(new Error("pattern error"));
                    return;
                }

                

                if (this.debug)
                    this.log("Sensor Value is currently at %s", sensorValue);

                this.statusCache.queried();
                callback(null, sensorValue);
            }
        });
    },

};
