// The shader good.rules names. The game compiles it, so the scan has to check it.
float4 main(float2 uv : TEXCOORD0) : SV_TARGET
{
	return float4(uv, 0, 1);
}
