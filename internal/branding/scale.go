// Copyright 2015 The Go Authors. All rights reserved.
// The interpolation arithmetic is adapted from golang.org/x/image/draw,
// distributed under the BSD-3-Clause license in THIRD_PARTY_NOTICES.md.

package branding

import (
	"image"
	"image/color"
	"image/draw"
)

// scaleIcon retains ApproxBiLinear's four-sample interpolation, specialized to
// the panel's NRGBA icons and Src operation. It avoids linking the unrelated
// affine transforms, masks, and destination-format kernels of x/image/draw.
func scaleIcon(dst *image.NRGBA, dr image.Rectangle, src image.Image) {
	sr := src.Bounds()
	if dr.Size() == sr.Size() {
		draw.Draw(dst, dr, src, sr.Min, draw.Src)
		return
	}
	if dr.Empty() || sr.Empty() {
		return
	}
	xscale, yscale := float64(sr.Dx())/float64(dr.Dx()), float64(sr.Dy())/float64(dr.Dy())
	sample := iconSampler(src)
	var pixel color.RGBA64
	for y := 0; y < dr.Dy(); y++ {
		y0, y1, yf := iconSamples((float64(y)+0.5)*yscale-0.5, sr.Dy())
		for x := 0; x < dr.Dx(); x++ {
			x0, x1, xf := iconSamples((float64(x)+0.5)*xscale-0.5, sr.Dx())
			r00, g00, b00, a00 := sample(sr.Min.X+x0, sr.Min.Y+y0)
			r10, g10, b10, a10 := sample(sr.Min.X+x1, sr.Min.Y+y0)
			r01, g01, b01, a01 := sample(sr.Min.X+x0, sr.Min.Y+y1)
			r11, g11, b11, a11 := sample(sr.Min.X+x1, sr.Min.Y+y1)
			pixel.R = iconBlend(r00, r10, r01, r11, xf, yf)
			pixel.G = iconBlend(g00, g10, g01, g11, xf, yf)
			pixel.B = iconBlend(b00, b10, b01, b11, xf, yf)
			pixel.A = iconBlend(a00, a10, a01, a11, xf, yf)
			dst.Set(dr.Min.X+x, dr.Min.Y+y, &pixel)
		}
	}
}

func iconSampler(src image.Image) func(int, int) (uint32, uint32, uint32, uint32) {
	if src, ok := src.(image.RGBA64Image); ok {
		return func(x, y int) (uint32, uint32, uint32, uint32) {
			p := src.RGBA64At(x, y)
			return uint32(p.R), uint32(p.G), uint32(p.B), uint32(p.A)
		}
	}
	if src, ok := src.(*image.YCbCr); ok {
		return func(x, y int) (uint32, uint32, uint32, uint32) { return src.YCbCrAt(x, y).RGBA() }
	}
	return func(x, y int) (uint32, uint32, uint32, uint32) { return src.At(x, y).RGBA() }
}

func iconSamples(position float64, size int) (int, int, float64) {
	first := int(position)
	if position < 0 {
		return 0, 0, 0
	}
	if first+1 >= size {
		return size - 1, size - 1, 1
	}
	return first, first + 1, position - float64(first)
}

func iconBlend(p00, p10, p01, p11 uint32, xf, yf float64) uint16 {
	top := float64((1-xf)*float64(p00)) + float64(xf*float64(p10))
	bottom := float64((1-xf)*float64(p01)) + float64(xf*float64(p11))
	return uint16(float64((1-yf)*top) + float64(yf*bottom))
}
