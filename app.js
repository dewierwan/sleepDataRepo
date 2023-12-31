/*
Next steps: 
- Fix the authorisation flaw where it doesn't like my work account
- make the code run on a consistent basis in github actions, and manages the API keys etc. appropriately
- Make it work on a daily etc. basis, and in a way that doesn't require me to login every time. Might require some updates to the authorisation
- Build nicer interfaces for tracking and monitoring sleep
- Test the code in a headless environment using something like Puppeteer, to test how well it'll work in GH Actions 
- Build automations to send emails to me or similar describing how I'm doing and maybe giving me a score or something 
- Review this original code for ways I could improve this code: https://ithoughthecamewithyou.com/post/export-google-fit-daily-steps-to-a-google-sheet
- Share my code with that thread?

Maybe in the future: 
- Replace the Google Fit API with the Garmin API if I get access to it 
- Have some alerts where if I go to bed really late I get an email the next day with some sleeping tips or something, or automatically pay someone money
*/

const express = require('express'); // Imports the Express module, which is used to build the server that handles incoming HTTP requests
const { google } = require("googleapis");
const cors = require("cors"); // Imports the CORS module, a security feature for browsers and servers
const urlParse = require("url-parse"); // provides an easy way to parse URLs in JS
const querystring = require('querystring');
const bodyParser = require("body-parser"); // used with Express to handle incoming requests 
const axios = require("axios"); // Used to make HTTP requests in Node.js
const Airtable = require('airtable');
const fs = require('fs');
const path = require('path');
const opn = require('opn');
require('dotenv').config(); // Load the dotenv variables into process.env

const app = express(); // Creates an Express application
const port = process.env.PORT;
const envFilePath = path.join(__dirname, '.env'); // Specify the path to the .env file
const callBackUrl = `http://localhost:${port}/refreshToken`;
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    callBackUrl
);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true}));
app.use(bodyParser.json());

// Starts the server
if (process.env.START_SERVER !== 'false'){
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}/`);
    });
}
app.get('/start', startProgram); // when a GET request comes in at /start, call the startProgram function
app.get('/refreshToken', updateRefreshToken); // when a GET request comes in at /start, call the startProgram function

startProgram();

async function startProgram(){   
    let tokens = await getAccessToken();
    if (tokens == false) {
        await openAuthUrl();
        return
    }    
    accessToken = tokens.res.data.access_token;
    getSleepData(accessToken);
}

Airtable.configure({ // Configure Airtable API, base, tables and fields
    apiKey: process.env.AIRTABLE_API_KEY 
});
const base = Airtable.base('appLVmFWWWnlIGvMI')
const tableAndFieldIds = {
    sessions: {
        tableId: "tblR6ODAu9xILUqbl", // session
        fieldIds: ["fldNhNZdVwWSZgkOw", "fld8aBjhqW3beQs08", "fldFHGy8fNkX6hMSj"] // 0 start, 1 end, 2 packageName
    },
    stages: {
        tableId: "tblz3ZNDcnR3JXbNx", // stage
        fieldIds: ["fldHAucUcx0EDYZR0", "fld7Tha1qd05Vm6iy", "fld6DKMwjSbvU7Ewr", "fldUU3NXW9nuKl9OJ"] // 0 start, 1 end, 2 value, 3 link
    }
};


async function createRecord(tableId, recordData) { // Create records in Airtable
    let recordToCreate = { fields: recordData };

    return new Promise((resolve, reject) => {
        base(tableId).create([recordToCreate], function(err, records) {
            if (err) {
                if (err.statusCode && err.statusCode === 429) {
                    console.warn("Being rate-limited by Airtable!!");

                    // If the error response contains the "Retry-After" header, 
                    // it indicates how many seconds to wait before making a new request.
                    if (err.headers && (err.headers['retry-after'] || err.headers['x-airtable-api-limits-retry-after-seconds'])) {
                        const retryAfter = err.headers['retry-after'] || err.headers['x-airtable-api-limits-retry-after-seconds'];
                        console.warn(`Suggested to wait for ${retryAfter} seconds before making another request.`);
                    }
                }
                console.error('Error creating record in table:', tableId);
                console.error('Record data:', JSON.stringify(recordToCreate, null, 2));
                console.error('Actual error:', err);
                reject(new Error(`Failed to create record in table ${tableId}. Error: ${err.message}`));
                return;
            } else {
                let id = records[0].getId();
                resolve(id);
            }
        });
    });
}

async function getAccessToken() {
    let refreshToken = process.env.GOOGLE_REFRESH_TOKEN
    
    if (!refreshToken) { // Handle empty refresh token
        console.log("Empty refresh token");
        return false
    }

    oauth2Client.setCredentials({    // Set refresh token 
        refresh_token: refreshToken
    });

    let tokens;
    try {
        tokens = await oauth2Client.getAccessToken();      
    } catch (err) {
        console.error('The refresh token is no longer working.');
        return false
    }

    const newToken = tokens.res.data.refresh_token;      // Update the refreshToken value 
    let envFileContent = fs.readFileSync(envFilePath, 'utf8'); // Read the existing content of the .env file      
    envFileContent = envFileContent.replace(/(GOOGLE_REFRESH_TOKEN=).*/, `$1${newToken}`); // Update the desired .env file data
    fs.writeFileSync(envFilePath, envFileContent, 'utf8'); // Write the new data to the .env file
    return tokens;
}

async function updateRefreshToken(req, res){
    const queryUrl = new urlParse(req.url); // parses the request URL into an object using the url-parse module
    const code = querystring.parse(queryUrl.query).code; // extracts the query parameters from the URL as an object
    tokens = await oauth2Client.getToken(code);

    const newToken = tokens.tokens.refresh_token
    let envFileContent = fs.readFileSync(envFilePath, 'utf8'); // Read the existing content of the .env file      
    envFileContent = envFileContent.replace(/(GOOGLE_REFRESH_TOKEN=).*/, `$1${newToken}`);
    fs.writeFileSync(envFilePath, envFileContent, 'utf8');

    // startProgram() // Better to just run the program twice if I need to reauthenticate
    process.exit(); 
}

async function openAuthUrl(){
    // Creates the authorization URL that the user uses to authorise access to the Google Fitness API
    // Declare the scopes needed to access Google Fitness API. Defines the permissions that will be requested.
    const scopes = [ 
        "https://www.googleapis.com/auth/fitness.activity.read https://www.googleapis.com/auth/fitness.sleep.read"
    ];

    // The oauth2Client.generateAuthUrl() method is called to generate the OAuth consent URL for Google's authorization server.
    // The generated URL is stored in the url variable. This is the OAuth consent screen URL.
    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        state: JSON.stringify({ // state contains data that will be passed back after consent, like the callbackUrl.
            callbackUrl: callBackUrl // this is the third argument in the oauth2client constant
            // userID: req.body.userid // Unclear if this is required or not
        })
    });

    // Open URL and wait for browser to close
    opn(url, {wait: true}).then(() => {
        console.log("Login screen opened!");
        return
    });
}   

async function airtableRecordLookup(sleepStartISO, sleepEndISO){
    // Set up query parameters to search for existing record 
    const tableId = tableAndFieldIds.sessions.tableId;
    const startTimeFieldId = tableAndFieldIds.sessions.fieldIds[0];
    const endTimeFieldId = tableAndFieldIds.sessions.fieldIds[1];

    const existingQuery = {
        filterByFormula: `AND(${startTimeFieldId} = '${sleepStartISO}', ${endTimeFieldId} = '${sleepEndISO}')`, 
        // maxResults: 1,
        sort: [{
            field: startTimeFieldId,
            direction: 'desc'
        }]
    };

    let existingRecords = await base(tableId)
        .select(existingQuery)
        .firstPage();

    // Check if matching record was found
    if (existingRecords[0]) {
        console.log(`Existing record found: ${JSON.stringify(existingRecords[0].id, null, 2)}`);
        return false
    } else {
        return true
    }
}

async function getSleepData(accessToken) {  
    let sleepId;
    let sleepArray = [];
    
    const daysAgo = 3;
    const now = Date.now(); // timestamp in milliseconds
    const startDateMilli = now - daysAgo * 24 * 60 * 60 * 1000;
    const startDate = new Date(startDateMilli);
    const endDateMilli = now
    const endDate = new Date(endDateMilli);

    // const startDate = new Date('2018-01-01T00:00:00Z');
    // const endDate = new Date('2020-12-31T00:00:00Z');
    
    console.log(`\nStart date: ${startDate}\nEnd date: ${endDate}\n`);

    try {
        const result = await axios({
            method: "GET",
            url: 'https://www.googleapis.com/fitness/v1/users/me/sessions',
            headers:{
                authorization: "Bearer " + accessToken
            },
            params: {
                startTime: startDate.toISOString(),
                endTime: endDate.toISOString(),
                activityType: 72
            }
        });
        const sessions = result.data.session;
        
        //console.log(`Sessions: ${JSON.stringify(sessions, null, 2)}`);
        try {
            for (let j = 0; j < sessions.length; j++) {
                let sleepStart = sessions[j].startTimeMillis;
                let sleepEnd = sessions[j].endTimeMillis;
                let sleepStartISO = new Date(parseInt(sleepStart)).toISOString();                
                let sleepEndISO = new Date(parseInt(sleepEnd)).toISOString();
                let source = sessions[j].application.packageName;
                let unique = await airtableRecordLookup(sleepStartISO)

                if (unique == false) {
                    continue;
                }

                const start = new Date(sleepStartISO);
                const end = new Date(sleepEndISO);
                
                // Calculate the difference in milliseconds
                const difference = end - start;
                
                // Check if the session is shorter than the threshold (5.5 hours)
                if (difference < 19800000) {
                    continue; // Skip if the session is shorter than the threshold
                }

                let tableId = tableAndFieldIds.sessions.tableId;
                let recordData = {
                    [tableAndFieldIds.sessions.fieldIds[0]]: sleepStartISO,
                    [tableAndFieldIds.sessions.fieldIds[1]]: sleepEndISO,
                    [tableAndFieldIds.sessions.fieldIds[2]]: source
                };
                                
                try {
                    sleepId = await createRecord(tableId, recordData);
                } catch (error) {
                    console.error(`Error creating record in table '${tableId}' with data:`, recordData, 'Error message:', error.message);
                }

                let sleepSession = {
                    startTime: sleepStart,
                    endTime: sleepEnd,
                    sessionId: sleepId,
                    sleepStages: []
                };
                sleepArray[j] = sleepSession;
                const dateObj = new Date(Number(sleepStart));
                const formatter = new Intl.DateTimeFormat('en-UK', { 
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                });
                //console.log(`Sleep record: ${formatter.format(dateObj)}`);

                try{
                    const stages = await axios({
                        method: "POST",
                        url: "https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate",
                        headers: {
                            "Content-Type": "application/json",
                            // authorization: "Bearer " + tokens.tokens.access_token
                            authorization: "Bearer " + accessToken
                        },
                        data: {
                            "aggregateBy": [
                                {
                                    "dataTypeName": "com.google.sleep.segment"
                                }
                            ],
                            startTimeMillis: sleepStart,
                            endTimeMillis: sleepEnd
                        }
                    });
                    
                    const points = stages.data.bucket[0].dataset[0].point; // Gets the sleep stages
                    
                    for (let point of points) {
                        //console.log(JSON.stringify(point,null,2));
                        let value = point.value[0].intVal;
                        let sleepStage = {
                            startTime: new Date(point.startTimeNanos / 1000000).toLocaleString(),
                            endTime: new Date(point.endTimeNanos / 1000000).toLocaleString(),
                            value: value,
                        };

                        let startIso = new Date(point.startTimeNanos / 1000000).toISOString();
                        let endIso = new Date(point.endTimeNanos / 1000000).toISOString();
                        let sleepId = sleepArray[j].sessionId;
                        
                        let tableId = tableAndFieldIds.stages.tableId;
                        let recordData = {
                            [tableAndFieldIds.stages.fieldIds[0]]: startIso,
                            [tableAndFieldIds.stages.fieldIds[1]]: endIso,
                            [tableAndFieldIds.stages.fieldIds[2]]: value,
                            [tableAndFieldIds.stages.fieldIds[3]]: [sleepId]
                        };
                        await createRecord(tableId, recordData);
                        sleepArray[j].sleepStages.push(sleepStage);
                    };
                } catch (e) {
                    console.log(e);
                }
            }
        } catch (e) {
            console.log(e);
        }
    } catch (e) {
        console.log(e);
    }
    console.log(`\nMay you have many more nights of wonderful sleep!\n`);
    process.exit(); 
};