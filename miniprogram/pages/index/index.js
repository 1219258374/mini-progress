Page({
  data: {},

  onLoad: function (options) {
    // Initialization
  },

  goToMBTI: function () {
    wx.navigateTo({
      url: '/pages/mbti/mbti',
    })
  },

  goToSoul: function () {
    wx.navigateTo({
      url: '/pages/soul/soul',
    })
  }
})
