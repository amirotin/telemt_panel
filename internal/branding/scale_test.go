package branding

import (
	"bytes"
	"image"
	"image/color"
	"testing"

	"golang.org/x/image/draw"
)

func TestIconScalingPreservesInterpolation(t *testing.T) {
	for _, bounds := range []image.Rectangle{image.Rect(0, 0, 1, 1), image.Rect(3, 5, 34, 22), image.Rect(0, 0, 701, 521)} {
		rgba, nrgba := image.NewRGBA(bounds), image.NewNRGBA(bounds)
		rgba64, nrgba64 := image.NewRGBA64(bounds), image.NewNRGBA64(bounds)
		gray := image.NewGray(bounds)
		gray16 := image.NewGray16(bounds)
		paletted := image.NewPaletted(bounds, color.Palette{color.Transparent, color.NRGBA{27, 51, 83, 127}, color.NRGBA{190, 17, 100, 255}})
		ycbcr := image.NewYCbCr(bounds, image.YCbCrSubsampleRatio420)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				pixel := color.NRGBA{uint8(x * 29), uint8(y * 31), uint8(x*y + 17), uint8((x + y) * 7)}
				rgba.Set(x, y, pixel)
				nrgba.Set(x, y, pixel)
				rgba64.Set(x, y, color.NRGBA64{uint16(x * 1009), uint16(y * 7919), uint16(x*y + 101), uint16((x + y) * 571)})
				nrgba64.Set(x, y, color.NRGBA64{uint16(x * 1009), uint16(y * 7919), uint16(x*y + 101), uint16((x + y) * 571)})
				gray.Set(x, y, pixel)
				gray16.Set(x, y, pixel)
				paletted.SetColorIndex(x, y, uint8((x+y)%3))
				ycbcr.Y[ycbcr.YOffset(x, y)] = uint8(x * y)
				ycbcr.Cb[ycbcr.COffset(x, y)] = uint8(x * 3)
				ycbcr.Cr[ycbcr.COffset(x, y)] = uint8(y * 5)
			}
		}
		for _, src := range []image.Image{rgba, nrgba, rgba64, nrgba64, gray, gray16, paletted, ycbcr} {
			for _, size := range []image.Point{{1, 1}, {19, 11}, {192, 192}, bounds.Size()} {
				dr := image.Rect(7, 13, 7+size.X, 13+size.Y)
				got, want := image.NewNRGBA(image.Rect(0, 0, dr.Max.X+1, dr.Max.Y+1)), image.NewNRGBA(image.Rect(0, 0, dr.Max.X+1, dr.Max.Y+1))
				scaleIcon(got, dr, src)
				draw.ApproxBiLinear.Scale(want, dr, src, bounds, draw.Src, nil)
				if !bytes.Equal(got.Pix, want.Pix) {
					t.Fatalf("changed interpolation: %T %v -> %v", src, bounds, size)
				}
			}
		}
	}
}

func BenchmarkIconScaling(b *testing.B) {
	src := image.NewNRGBA(image.Rect(0, 0, 1024, 768))
	dst := image.NewNRGBA(image.Rect(0, 0, 512, 512))
	dr := image.Rect(0, 64, 512, 448)
	for _, benchmark := range []struct {
		name string
		run  func()
	}{
		{"specialized", func() { scaleIcon(dst, dr, src) }},
		{"reference", func() { draw.ApproxBiLinear.Scale(dst, dr, src, src.Bounds(), draw.Src, nil) }},
	} {
		b.Run(benchmark.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmark.run()
			}
		})
	}
}
