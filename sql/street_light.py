import pandas as pd

all_data = []

# 台北市
taipei = pd.read_csv("C:\Users\zhangruyan\Desktop\112-project\sql\TaipeiLight.csv")

taipei_new = pd.DataFrame({
    "lamp_id": taipei["SerialNumb"],
    "city": "台北市",
    "district": taipei["Dist"],
    "address": None,
    "lamp_type": taipei["LightKind1"],
    "wattage": taipei["LightWatt1"],
    "longitude": None,
    "latitude": None
})

all_data.append(taipei_new)

# 新北市
newtaipei = pd.read_csv("C:\Users\zhangruyan\Desktop\112-project\sql\新北市路燈資料.csv")

newtaipei_new = pd.DataFrame({
    "lamp_id": newtaipei["seqno"],
    "city": "新北市",
    "district": newtaipei["town"],
    "address": newtaipei["address"],
    "lamp_type": None,
    "wattage": newtaipei["power"],
    "longitude": newtaipei["longitude"],
    "latitude": newtaipei["latitude"]
})

all_data.append(newtaipei_new)

# 合併
result = pd.concat(all_data)

result.to_csv(
    "output/street_light_all.csv",
    index=False,
    encoding="utf-8-sig"
)

print("完成")