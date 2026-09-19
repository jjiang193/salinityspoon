# Voice Assistant Integration (Amazon Alexa & Google Assistant)

This document outlines the future architecture for integrating the NaTrack Salinity Spoon with smart home voice assistants. This will allow patients to ask "Alexa, how much sodium have I had today?" or receive proactive voice alerts when they are eating too fast.

This design builds directly on the production AWS Serverless architecture outlined in `natrack-system-design.pdf`.

## 1. High-Level Architecture

Both Amazon Alexa (Custom Skills) and Google Assistant (Conversational Actions) use webhook endpoints to fulfill user intents. Because our production architecture already uses **AWS API Gateway** and **AWS Lambda** for the clinician/patient REST API, we can seamlessly expose new endpoints specifically for voice fulfillment.

### Flow of a Voice Request
1. **User speaks:** *"Alexa, ask Meal Hero how much sodium I've eaten today."*
2. **NLP Cloud (Amazon/Google):** Transcribes the speech, matches it to the `GetDailySodiumIntent`, and sends a JSON payload to our fulfillment webhook.
3. **API Gateway:** Receives the webhook request and routes it to the `VoiceFulfillmentLambda`.
4. **VoiceFulfillmentLambda:** 
   - Validates the OAuth 2.0 token (Account Linking via Cognito).
   - Queries the **DynamoDB Patients/Meals Table** (via the exact same internal data access layer the React dashboard uses) for `intake_today`.
   - Generates the natural language response (using our Gemini AI prompt logic).
5. **Smart Speaker:** *"You've had 1,250 milligrams of sodium today, which is well within your target."*

## 2. Authentication (Account Linking)

To ensure privacy (HIPAA compliance), the voice assistant must securely identify which patient is speaking.

- **AWS Cognito** acts as our OAuth 2.0 Identity Provider.
- When the user enables the "Meal Hero" skill in their Alexa/Google Home app, they will be prompted to log in using their Cognito credentials.
- The Voice Assistant platform stores an Access Token. Every request sent to our `VoiceFulfillmentLambda` will include this token.
- The Lambda verifies the token with Cognito to securely extract the `patientId`.

## 3. Proactive Voice Alerts (Push Notifications)

Instead of just answering questions, the system can proactively warn the user if they eat too fast or exceed their sodium limit *while* they are eating.

### AWS IoT to Alexa Proactive Events
1. As detailed in the system design, the spoon publishes bites to **AWS IoT Core** via MQTT.
2. The **Ingest Lambda** processes the bite, updates DynamoDB, and checks if a threshold is crossed (e.g., pace < 15 seconds, or total sodium > target).
3. If a threshold is crossed, the Ingest Lambda pushes a message to an **Amazon SQS** queue dedicated to alerts.
4. An **Alerting Lambda** consumes the queue and calls the **Alexa ProactiveEvents API** (or Google Assistant Notifications API).
5. The smart speaker chimes and announces: *"Meal Hero alert: Your sodium intake for this meal has reached your 500 milligram limit."*

## 4. Required Cloud Infrastructure Additions

To support this on top of our existing AWS footprint:

*   **1 New API Gateway Route:** `/api/voice-fulfillment` (unauthenticated by AWS IAM, but validates the OAuth bearer token in the Lambda).
*   **1 New Lambda Function:** `VoiceFulfillmentLambda` containing the Alexa Skills Kit (ASK) SDK / Google Actions SDK.
*   **Cognito App Client Update:** Enable OAuth 2.0 Authorization Code Grant for the Alexa/Google callback URLs.
*   **AWS Secrets Manager:** To store the Alexa Client ID / Secret required for the Proactive Events API.

## 5. Development Steps

1. **Define the Voice Interaction Model:** Create the intents in the Alexa Developer Console (e.g., `GetSodiumIntent`, `LogManualFoodIntent`, `ChangeFoodMatrixIntent`).
2. **Port the Persona:** Take the prompt instructions currently in `minerals.py` (which enforce the ±25% confidence ranges) and use them to format the Text-To-Speech (TTS) strings returned by the Lambda.
3. **Set up Account Linking:** Configure the Alexa console with the AWS Cognito Hosted UI URL.
4. **Deploy the Webhook:** Use AWS SAM or Serverless Framework to deploy the new Lambda alongside the existing backend stack.