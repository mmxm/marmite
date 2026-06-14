import os
import zipfile
import json
import re
from datetime import datetime

ZIP_PATH = "mealie_2026.03.23.09.25.21.zip"
OUTPUT_DB = "recipes.json"
IMAGES_DIR = "images"

def parse_duration(d):
    if not d:
        return 0
    if isinstance(d, int):
        return d
    if isinstance(d, float):
        return int(d)
    
    # Matches ISO 8601 duration like "PT15M", "PT1H30M", "PT2H"
    match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?', str(d))
    if match:
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        return hours * 60 + minutes
    
    try:
        return int(str(d))
    except ValueError:
        return 0

def clean_now_iso():
    return datetime.utcnow().isoformat() + "Z"

def main():
    if not os.path.exists(ZIP_PATH):
        print(f"Error: ZIP file '{ZIP_PATH}' not found in current directory.")
        return

    # Create images directory
    if not os.path.exists(IMAGES_DIR):
        os.makedirs(IMAGES_DIR)
        print(f"Created directory: {IMAGES_DIR}")

    print(f"Opening Mealie backup ZIP: {ZIP_PATH}...")
    
    with zipfile.ZipFile(ZIP_PATH, 'r') as zip_ref:
        # Load database.json
        print("Reading database.json...")
        with zip_ref.open("database.json") as db_file:
            db = json.loads(db_file.read().decode('utf-8'))

        # Build mappings
        print("Indexing Mealie master tables...")
        
        # 1. Categories Mapping (id -> name)
        categories_map = {}
        for cat in db.get("categories", []):
            categories_map[cat["id"]] = cat["name"]
            
        # 2. Recipe-Category links
        recipe_category_map = {}
        for link in db.get("recipes_to_categories", []):
            recipe_category_map[link["recipe_id"]] = link["category_id"]

        # 3. Ingredients foods & units
        food_map = {food["id"]: food["name"] for food in db.get("ingredient_foods", [])}
        unit_map = {unit["id"]: unit.get("abbreviation") or unit["name"] for unit in db.get("ingredient_units", [])}

        # 4. Ingredients list by recipe_id
        recipe_ingredients = {}
        for ing in db.get("recipes_ingredients", []):
            r_id = ing["recipe_id"]
            if r_id not in recipe_ingredients:
                recipe_ingredients[r_id] = []
            
            # Map name/unit
            name = food_map.get(ing.get("food_id"), "")
            unit = unit_map.get(ing.get("unit_id"), "")
            qty = ing.get("quantity")
            
            # If food name is missing but original text exists, use original text
            if not name and ing.get("original_text"):
                name = ing.get("original_text")
                # Clear quantity/unit since they are baked into the raw text
                qty = None
                unit = ""
                
            recipe_ingredients[r_id].append({
                "name": name,
                "quantity": qty,
                "unit": unit,
                "position": ing.get("position", 99)
            })

        # 5. Instructions (steps) by recipe_id
        recipe_steps = {}
        for step in db.get("recipe_instructions", []):
            r_id = step["recipe_id"]
            if r_id not in recipe_steps:
                recipe_steps[r_id] = []
            recipe_steps[r_id].append({
                "text": step.get("text", "").strip(),
                "position": step.get("position", 99)
            })

        # Process recipes
        print(f"Processing {len(db.get('recipes', []))} recipes...")
        marmite_recipes = []
        imported_count = 0
        
        for recipe in db.get("recipes", []):
            r_uuid = recipe["id"]
            r_slug = recipe["slug"]
            
            # Sort ingredients and steps by position
            ingredients = sorted(recipe_ingredients.get(r_uuid, []), key=lambda x: x["position"])
            # Remove helper position key
            for ing in ingredients:
                ing.pop("position", None)
                
            steps = [s["text"] for s in sorted(recipe_steps.get(r_uuid, []), key=lambda x: x["position"]) if s["text"]]
            
            # Get category
            cat_id = recipe_category_map.get(r_uuid)
            category_name = categories_map.get(cat_id, "Plat")
            
            # Check for image inside zip
            image_zip_path = f"data/recipes/{r_uuid}/images/original.webp"
            has_image = False
            image_filename = ""
            
            # Check if file exists in zip Ref
            try:
                zip_ref.getinfo(image_zip_path)
                has_image = True
            except KeyError:
                pass
                
            if has_image:
                # Extract image to local images folder
                dest_image_name = f"{r_slug}.webp"
                dest_image_path = os.path.join(IMAGES_DIR, dest_image_name)
                
                with zip_ref.open(image_zip_path) as source_img:
                    with open(dest_image_path, "wb") as target_img:
                        target_img.write(source_img.read())
                
                image_filename = f"images/{dest_image_name}"
            
            # Servings & Times
            servings = int(recipe.get("recipe_servings") or recipe.get("recipe_yield_quantity") or 4)
            if servings <= 0:
                servings = 4
                
            prep_time = parse_duration(recipe.get("prep_time"))
            cook_time = parse_duration(recipe.get("cook_time"))
            if prep_time == 0 and cook_time == 0:
                prep_time = 15
                cook_time = 30 # standard default
            
            # Build Marmite recipe
            marmite_recipe = {
                "id": "recipe_" + r_slug.replace("-", "_"),
                "title": recipe["name"],
                "description": recipe.get("description") or "",
                "prepTime": prep_time,
                "cookTime": cook_time,
                "servings": servings,
                "category": category_name,
                "tags": [category_name] if category_name else [],
                "ingredients": ingredients,
                "steps": steps,
                "imageId": image_filename,
                "createdAt": recipe.get("date_added") or clean_now_iso(),
                "updatedAt": recipe.get("date_updated") or clean_now_iso()
            }
            
            marmite_recipes.append(marmite_recipe)
            imported_count += 1
            print(f" - Imported: {recipe['name']} (Image: {'Yes' if has_image else 'No'})")
            
        # Save output DB
        with open(OUTPUT_DB, "w", encoding="utf-8") as out_file:
            json.dump(marmite_recipes, out_file, indent=2, ensure_ascii=False)
            
        print(f"\nMigration complete! {imported_count} recipes imported successfully.")
        print(f"Output database saved to: {OUTPUT_DB}")
        print(f"Extracted images directory: {IMAGES_DIR}/")
        print("Next time you launch Marmite, it will automatically load this database.")

if __name__ == "__main__":
    main()
