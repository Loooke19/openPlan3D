"""Generic Chinese hospital room / department vocabulary for OCR correction.

Built from common public department and room naming (国家卫健委诊疗科目、常见门诊/病房/医技/
后勤房间名), NOT from any particular drawing's room list. Used to fix single-glyph OCR
errors (谈证室→谈话室, 物盗库户→物资库房) and to judge whether two OCR lines form one name.
An optional per-floor name list supplied at import can be added with ``extra``.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

_DEPTS = """
内科 外科 儿科 妇科 产科 妇产科 眼科 耳鼻喉科 口腔科 皮肤科 中医科 针灸科 推拿科 康复科 理疗科 骨科 神经内科 神经外科
心内科 心血管内科 呼吸内科 消化内科 肾内科 内分泌科 血液科 肿瘤科 感染科 急诊科 麻醉科 放射科 检验科 病理科 超声科
核医学科 药剂科 营养科 精神科 心理科 老年科 全科 预防保健科 公共卫生科 公共卫生管理科 计划生育科 妇女保健科 儿童保健科
体检科 健康管理科 医务科 护理部 院办 财务科 总务科 信息科 设备科 保卫科 疼痛科 戒烟门诊 发热门诊 肠道门诊 慢病门诊
慢病联合门诊 专家门诊 普通门诊 中医特色门诊 中医专家门诊 外科专家门诊 内科专家门诊 眼科专家门诊 耳鼻喉科专家门诊
口腔科专家门诊 狂犬病暴露预防处置门诊 犬伤门诊 计免门诊 预防接种门诊 中医体质辨识 卫生健康监督 卫生监督 健康教育
"""
_ROOMS = """
柜子 货架 器械柜
诊室 专家诊室 中医专家诊室 内科诊室 外科诊室 妇科诊室 儿科诊室 眼科诊室 口腔诊室 治疗室 处置室 处置间 处置区 换药室 注射室
输液室 输液大厅 夜间输液室 雾化室 抢救室 留观室 观察室 采血室 抽血室 体检抽血 抽血 采样室 检验室 化验室 生化室 免疫室 细菌室 微生物室
标本接收 标本接收室 心电图室 B超室 超声室 彩超室 CT室 MRI室 DR室 X光室 放射室 胃镜室 肠镜室 内窥镜室 内镜室 骨密度检测
骨密度检测室 肺功能室 脑电图室 听力室 视力室 视功能训练室 验光室 配镜室 手术室 计划生育手术室 人流手术室 恢复室 准备室
清洗间 冲洗间 打包间 打包室 无菌包室 消毒室 供应室 洗手间 洗手池 污物间 医废室 医疗废物暂存间 废弃物 垃圾间 洁具间
挂号 挂号处 挂号室 收费 收费处 收费室 挂号收费 药房 西药房 中药房 中药库 药库 药剂存放处 发药窗口 取药处 导医台 服务台
咨询台 护士站 医生办公室 护士办公室 主任办公室 办公室 会议室 示教室 值班室 医生值班室 护士值班室 更衣室 医生更衣 更衣
休息室 休息区 候诊区 候诊厅 等候区 门厅 大厅 门诊大厅 走廊 过道 公共过道 楼梯 楼梯间 电梯 电梯厅 前室 卫生间 男卫
女卫 残卫 无障碍卫生间 母婴室 开水间 开水茶水间 茶水间 储藏室 储藏 储物间 库房 物资库房 器械库 被服库 配电间 配电室
弱电间 强电间 机房 空调机房 新风机房 消控室 监控室 管道井 水井 电井 风井 病房 单人病房 双人病房 隔离病房 谈话室
健康教育室 健康证体检 体检外科 体检内科 体检眼科 体检耳鼻喉科 体检窗口 登记 登记处 登记室 计生咨询指导室 心理咨询室
心理测评室 心理行为与智力测查室 智力测查室 母婴室 冷链室 疫苗接种室 接种室 接种留观 计免留观室 预检分诊 分诊台 一脱间
二脱间 卫 缓冲间 清洁区 污染区 半污染区 仪器室 控制室 档案室 病案室 资料室 信息机房 空调外机 庭院 天井 上空 中庭
"""

# Known OCR / typing homophone misreads (fixed regardless of OCR confidence). The misread
# stays searchable as an alias, e.g. 心里咨询室 → 心理咨询室 (aliases 心里咨询室, 心里).
MISREADS = {"心里": "心理"}


def fix_misreads(text: str) -> tuple[str, list[str]]:
    """Return (fixed text, aliases to keep). Aliases empty when nothing changed."""
    fixed, aliases = text or "", []
    for bad, good in MISREADS.items():
        if bad in fixed and good not in fixed:
            aliases += [fixed, bad]
            fixed = fixed.replace(bad, good)
    return fixed, aliases


BASE = sorted({w for w in (_DEPTS + _ROOMS).split() if w})
_SUFFIX = re.compile(r"(室|科|门诊|诊|房|间|区|处|站|台|厅|中心|库|井|道|测|更衣|大厅)$")
_NUM_TAIL = re.compile(r"([0-9一二三四五六七八九十]+|[（(].*[)）])$")


def _stem(text: str) -> tuple[str, str]:
    """Split a trailing number / bracket note (内科诊室1 → 内科诊室 + 1)."""
    m = _NUM_TAIL.search(text)
    if m and m.start() >= 2:
        return text[: m.start()], text[m.start():]
    return text, ""


def lexicon(extra=None) -> list[str]:
    return sorted(set(BASE) | {str(x).strip() for x in extra or [] if str(x).strip()})


def known(text: str, words=None) -> bool:
    words = words if words is not None else BASE
    stem, _ = _stem(text)
    return text in words or stem in words


def looks_complete(text: str) -> bool:
    return bool(_SUFFIX.search(_stem(text)[0]))


def correct(text: str, extra=None, *, strict_extra=False) -> str:
    """Replace `text` by a lexicon word when it differs by one glyph (two for long names).
    Same length only for 1-edit fixes, so 内科 never becomes 内科诊室. Returns text unchanged
    when no single best candidate exists."""
    if not text or not re.search(r"[\u4e00-\u9fff]", text):
        return text
    text = fix_misreads(text)[0]
    words = lexicon(extra)
    stem, tail = _stem(text)
    if stem in words or text in words:
        return text
    best, best_score, tie = None, 0.0, False
    pool = (lexicon(None) if not strict_extra else []) + list(extra or [])
    for w in set(pool):
        if abs(len(w) - len(stem)) > (1 if len(stem) >= 5 else 0):
            continue
        diff = sum(1 for a, b in zip(w, stem) if a != b) + abs(len(w) - len(stem))
        limit = 1 if len(stem) <= 4 else 2
        if len(w) != len(stem):
            # Never add/drop a numeral (计免留观一室 must not become 计免留观室).
            if re.search(r"[0-9一二三四五六七八九十]", stem + w):
                continue
            score = SequenceMatcher(None, w, stem).ratio()
            if score < 0.85:
                continue
        elif diff > limit or diff == len(stem):
            continue
        else:
            score = 1 - diff / max(len(stem), 1)
        if score > best_score + 1e-9:
            best, best_score, tie = w, score, False
        elif abs(score - best_score) < 1e-9:
            tie = True
    if best and not tie and best_score >= 0.6:
        return best + tail
    return text
