// A copy nothing references, with the broken include such a copy carries. The game never compiles
// it, so the panel must stay quiet about it.
#include "no_such_base.shader"

float4 main(float2 uv : TEXCOORD0) : SV_TARGET
{
	return float4(uv, 0, 1);
}
