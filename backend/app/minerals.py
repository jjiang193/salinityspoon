"""Food matrix mineral calibration and AI fallback.

This module provides standard broths and their correction factors to account for
background ions (like potassium and magnesium) that artificially inflate the EC reading.
"""

import random
from typing import Dict, List, Optional
from pydantic import BaseModel

class FoodMatrix(BaseModel):
    id: str
    name: str
    correction_factor: float
    description: str

# Default offline database of standard broths.
# A correction factor of 1.0 means no correction (assume all EC is from NaCl).
# A correction factor of < 1.0 reduces the estimated sodium to account for background ions.
FOOD_MATRICES: Dict[str, FoodMatrix] = {
    "default": FoodMatrix(
        id="default",
        name="Standard (No Correction)",
        correction_factor=1.0,
        description="Assumes all electrical conductivity comes from sodium chloride."
    ),
    "chicken_broth": FoodMatrix(
        id="chicken_broth",
        name="Chicken Broth (USDA)",
        correction_factor=0.95, 
        description="Based on USDA commercial canned broth: ~1537mg Sodium to ~50mg Potassium. Potassium contributes ~5% of total EC."
    ),
    "beef_broth": FoodMatrix(
        id="beef_broth",
        name="Beef Broth (USDA)",
        correction_factor=0.55,
        description="Based on USDA home-prepared beef stock: ~475mg Sodium to ~444mg Potassium. Because Potassium is highly conductive and present in equal mass, it contributes ~45% of total EC."
    ),
    "miso_soup": FoodMatrix(
        id="miso_soup",
        name="Miso Soup",
        correction_factor=0.85, 
        description="Traditional miso paste contains significant fermented soybean potassium and magnesium alongside salt."
    ),
    "vegetable_broth": FoodMatrix(
        id="vegetable_broth",
        name="Vegetable Broth",
        correction_factor=0.60, 
        description="High potassium levels from root vegetables contribute roughly 40% of the electrical conductivity."
    ),
}

def get_all_matrices() -> List[FoodMatrix]:
    return list(FOOD_MATRICES.values())

def get_matrix(matrix_id: str) -> Optional[FoodMatrix]:
    return FOOD_MATRICES.get(matrix_id)

def generate_echo_debrief(meal_stats: dict) -> str:
    """Generates a mock echo voice debrief."""
    total_sodium = meal_stats.get("total_sodium_mg", 0)
    bites = meal_stats.get("bite_count", 0)
    pace = meal_stats.get("average_pace_seconds", 0)
    
    if total_sodium > 1500:
        sodium_msg = f"Your meal had a high sodium content of {total_sodium:.0f} milligrams, which is over the AHA ideal limit for an entire day."
    else:
        sodium_msg = f"Your meal had {total_sodium:.0f} milligrams of sodium, keeping you on track."
        
    if pace and pace < 10:
        pace_msg = f"You ate quite fast, averaging one bite every {pace:.0f} seconds. Try to slow down to help with digestion and fullness."
    elif pace:
        pace_msg = f"You kept a healthy pace of {pace:.0f} seconds per bite."
    else:
        pace_msg = ""
        
    intros = [
        "Here's your meal debrief.",
        "Let's review your last meal.",
        "Meal analysis complete.",
    ]
    
    return f"{random.choice(intros)} You took {bites} bites. {sodium_msg} {pace_msg}"

import os
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    
ACTIVE_PERSONA = {
    "condition": "none",
    "sodium_limit_mg": 2300
}

def set_persona(condition: str, limit: int):
    ACTIVE_PERSONA["condition"] = condition
    ACTIVE_PERSONA["sodium_limit_mg"] = limit

def chat_with_echo(user_message: str, meal_stats: dict) -> str:
    """Generates a conversational response using Gemini."""
    total_sodium = meal_stats.get("total_sodium_mg", 0)
    bites = meal_stats.get("bite_count", 0)
    pace = meal_stats.get("average_pace_seconds", 0)
    matrix_id = meal_stats.get("matrix_id", "default")

    if not GEMINI_API_KEY:
        return "I'm offline right now, but you've had " + f"{total_sodium:.0f} milligrams of sodium in {bites} bites."

    condition_text = ""
    if ACTIVE_PERSONA["condition"].lower() != "none":
        condition_text = f"IMPORTANT USER PROFILE: The user has {ACTIVE_PERSONA['condition']} and must adhere to a strict low-sodium diet. "
        
    # Estimate other ions based on the food matrix
    k_mult, ca_mult, mg_mult, po4_mult, so4_mult = 0.0, 0.0, 0.0, 0.0, 0.0
    if matrix_id == "chicken_broth":
        k_mult, ca_mult, mg_mult, po4_mult, so4_mult = 0.03, 0.01, 0.02, 0.08, 0.04
    elif matrix_id == "beef_broth":
        k_mult, ca_mult, mg_mult, po4_mult, so4_mult = 0.93, 0.02, 0.03, 0.12, 0.06
    elif matrix_id == "vegetable_broth":
        k_mult, ca_mult, mg_mult, po4_mult, so4_mult = 1.20, 0.05, 0.04, 0.02, 0.01
    elif matrix_id == "miso_soup":
        k_mult, ca_mult, mg_mult, po4_mult, so4_mult = 0.20, 0.02, 0.05, 0.04, 0.02

    potassium = total_sodium * k_mult
    calcium = total_sodium * ca_mult
    magnesium = total_sodium * mg_mult
    chloride = total_sodium * 1.54  # standard salt ratio
    phosphate = total_sodium * po4_mult
    sulfate = total_sodium * so4_mult
    
    # Calculate confidence ranges (±10% for Sodium/Chloride, ±25% for other inferred ions)
    ion_text = (
        f"- Cations: Sodium: {total_sodium*0.9:.0f}-{total_sodium*1.1:.0f}mg, "
        f"Potassium: {potassium*0.75:.0f}-{potassium*1.25:.0f}mg, "
        f"Calcium: {calcium*0.75:.0f}-{calcium*1.25:.0f}mg, "
        f"Magnesium: {magnesium*0.75:.0f}-{magnesium*1.25:.0f}mg\n"
        f"- Anions: Chloride: {chloride*0.9:.0f}-{chloride*1.1:.0f}mg, "
        f"Phosphate: {phosphate*0.75:.0f}-{phosphate*1.25:.0f}mg, "
        f"Sulfate: {sulfate*0.75:.0f}-{sulfate*1.25:.0f}mg"
    )

    # Get the human-readable name of the matrix
    matrix_obj = get_matrix(matrix_id)
    food_name = matrix_obj.name if matrix_obj else "Standard Food"

    system_prompt = (
        "You are 'Echo', a conversational voice assistant for the Salinity Spoon smart device. "
        "Your job is to provide short, helpful, and conversational answers to a user eating a meal. "
        "Speak naturally, as if you are a smart speaker reading aloud. Keep answers under 2 sentences. "
        f"{condition_text}"
        f"Their daily sodium limit is strictly {ACTIVE_PERSONA['sodium_limit_mg']} mg. "
        "You should be highly attentive to this medical context and gently warn them if their intake is risky. "
        "Here are the user's current live meal stats:\n"
        f"- Selected Food Profile: {food_name}\n"
        f"- Bites taken: {bites}\n"
        f"- Average pace: {pace:.0f} seconds per bite.\n"
        "Estimated Ion Profile (based on food matrix and sensor confidence intervals):\n"
        f"{ion_text}\n"
        "Do not list all the stats unless asked. Because nothing is exact, ALWAYS speak about these ions as an estimated range (e.g., 'about 50 to 70 milligrams'). Just answer the specific question they asked using the context provided."
    )

    try:
        model = genai.GenerativeModel("gemini-3.6-flash", system_instruction=system_prompt)
        response = model.generate_content(user_message)
        return response.text.strip()
    except Exception as e:
        print(f"Gemini error: {e}")
        return "I'm having trouble connecting to my brain right now."

