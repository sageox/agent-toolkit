import json
import os

# Replace this bounded operation with your domain script. Inputs are data in JOB_PARAM_*.
value = int(os.environ.get("JOB_PARAM_NUMBER", "7"))
with open(os.environ["JOB_VERDICT_PATH"], "w") as result:
    json.dump({"gates": [{"gate": "positive-number", "executed": True,
                           "exitCode": 0 if value > 0 else 1}]}, result)
