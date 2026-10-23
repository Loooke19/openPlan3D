import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from hospital_lexicon import fix_misreads, correct


def test_xinli_fixed_and_alias_kept():
    assert fix_misreads("心里咨询室") == ("心理咨询室", ["心里咨询室", "心里"])
    assert correct("心里咨询室") == "心理咨询室"
    assert fix_misreads("心理测评室") == ("心理测评室", [])
